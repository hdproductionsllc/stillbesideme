/**
 * Production Release — the single path from "this tribute is approved" to
 * "this tribute is at the printer".
 *
 * Called by src/routes/adminReview.js when a human releases an order whose
 * customer already approved the proof inline, before paying.
 *
 * This mirrors, step for step, the pipeline still living inside
 * src/routes/proofApproval.js. That duplication is deliberate and temporary:
 * proofApproval.js serves orders that were already mid-round-trip when inline
 * approval shipped, and those are paid orders in flight — refactoring the code
 * underneath them buys nothing and risks everything. When the last legacy
 * order clears, that route (and sendProofEmail with it) can simply be deleted
 * and this becomes the only copy.
 *
 * Steps, in order, and why each failure is treated the way it is:
 *   1. Mark the order proof_approved (never overwriting an inline approval
 *      timestamp — that is the customer's own, and it is evidence).
 *   2. Render the full-resolution, unwatermarked print file. FATAL: without it
 *      there is nothing to print, so this throws and the caller answers 500.
 *   3. Render the insert card. NON-FATAL: a missing card costs the box its
 *      letter; failing hard here would strand an order that is ready to print.
 *   4. Submit to the fulfillment provider. NON-FATAL: reported back on the
 *      result so the caller can say so, and retryable from the admin order page.
 *   5. Optionally email the customer that their tribute is being printed.
 */

const emailService = require('./emailService');

/**
 * Release an approved order to production.
 *
 * @param {object} db      — the sql.js wrapper (synchronous get/run/all)
 * @param {object} order   — the full order row
 * @param {object} options
 * @param {boolean} options.notifyCustomer — send the "being printed" email
 *        (true for the legacy email round-trip, false for the inline flow
 *        where the customer already has their order-confirmation email).
 * @param {string} options.context — short label used in admin alert copy.
 *
 * @returns {Promise<{printFileUrl: string, noteFileUrl: string|null,
 *                    provider: string, reference: string|null,
 *                    fulfillmentError: string|null}>}
 * @throws {Error} only when the print file cannot be rendered.
 */
async function releaseToProduction(db, order, options = {}) {
  const { notifyCustomer = true, context = 'proof approval' } = options;
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
  const shortId = order.id.substring(0, 8).toUpperCase();

  // 1. Mark approved. COALESCE protects an inline approval timestamp: for the
  //    inline flow proof_approved_at was written at checkout, before payment,
  //    and it must keep saying when the CUSTOMER approved — not when an admin
  //    released it. For legacy orders the column is NULL here, so this is
  //    byte-for-byte the old behaviour.
  db.run(
    `UPDATE orders SET
       status = 'proof_approved',
       proof_approved_at = COALESCE(proof_approved_at, datetime('now')),
       updated_at = datetime('now')
     WHERE id = ?`,
    [order.id]
  );

  // 2. Print-ready file (full-resolution composite, no watermark) — fatal.
  const printRenderer = require('./printRenderer');
  let printFileUrl;
  try {
    const { printRelativeUrl } = await printRenderer.generatePrintFile(order);
    printFileUrl = printRelativeUrl;
    db.run('UPDATE orders SET print_file_url = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [printRelativeUrl, order.id]);
    console.log(`Print-ready file generated for order ${order.id}: ${printRelativeUrl}`);
  } catch (err) {
    console.error(`Failed to generate print-ready file for order ${order.id}:`, err.message);
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [order.id, 'print_render_failed', JSON.stringify({ error: err.message })]
    );

    // Alert the admin — the order is approved but nothing can print.
    try {
      await emailService.sendAdminAlert(
        `Order ${shortId} stalled: print render failed`,
        `Order ${shortId} was approved but the print-ready file could not be generated.\n\n` +
        `Order ID: ${order.id}\n` +
        `Step: print render (${context})\n` +
        `Error: ${err.message}\n\n` +
        `Review page: ${baseUrl}/admin/review/${order.admin_token}`
      );
    } catch (alertErr) {
      console.error(`Failed to send admin alert for order ${order.id}:`, alertErr.message);
    }

    throw err;
  }

  // 3. Insert card — EVERY physical box gets one (Luma printouts are free):
  // the sender's personal note, a generic gift card, or a thank-you card with
  // a Story Vault QR for self purchases. Rendered here, beside the print file,
  // because the QR points at a page that only exists once the poem is final.
  //
  // Deliberately non-fatal, unlike the print render above: a missing card
  // costs the box its letter, but a hard failure here would strand an
  // approved order that is otherwise ready to print. Log it, alert, ship the
  // frame.
  let noteFileUrl = null;
  try {
    const { generateNoteCard } = require('./noteCardRenderer');
    const vault = db.get('SELECT token FROM vaults WHERE order_id = ?', [order.id]);
    const noteResult = await generateNoteCard(order, { vaultToken: vault ? vault.token : null });
    if (noteResult) {
      noteFileUrl = noteResult.noteRelativeUrl;
      db.run('UPDATE orders SET note_file_url = ?, updated_at = datetime(\'now\') WHERE id = ?',
        [noteResult.noteRelativeUrl, order.id]);
      console.log(`Insert card (${noteResult.variant}) generated for order ${order.id}: ${noteResult.noteRelativeUrl}`);
    }
  } catch (err) {
    console.error(`Failed to generate insert card for order ${order.id}:`, err.message);
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [order.id, 'note_render_failed', JSON.stringify({ error: err.message })]
    );
    try {
      await emailService.sendAdminAlert(
        `Order ${shortId}: insert card failed to render`,
        `The frame will still print, but the card will not be in the box.\n\n` +
        `Order ID: ${order.id}\nError: ${err.message}`
      );
    } catch (alertErr) {
      console.error(`Failed to send admin alert for order ${order.id}:`, alertErr.message);
    }
  }

  // 4. Submit to the fulfillment provider (shared with the admin resubmit route).
  //    Re-fetch the order so the submitter sees print_file_url.
  const { submitFulfillment, resolveProvider } = require('./fulfillmentSubmitter');
  const updatedOrder = db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
  const provider = resolveProvider(updatedOrder);
  let reference = null;
  let fulfillmentError = null;

  try {
    const result = await submitFulfillment(updatedOrder, db);
    reference = result.reference || null;
    console.log(`Order ${order.id} released to production — submitted to ${result.provider}${reference ? `: ${reference}` : ''}`);
  } catch (err) {
    fulfillmentError = err.message;
    console.error(`Failed to submit order ${order.id} to ${provider} after approval:`, err.message);
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [order.id, `${provider}_submit_failed`, JSON.stringify({ error: err.message })]
    );
    // The order is still saved as proof_approved — fulfillment can be retried
    // from the admin order page (Resubmit fulfillment button).
    try {
      await emailService.sendAdminAlert(
        `Order ${shortId} stalled: ${provider} submit failed`,
        `Order ${shortId} was approved but could not be submitted to ${provider}.\n\n` +
        `Order ID: ${order.id}\n` +
        `Step: fulfillment submit (${context})\n` +
        `Error: ${err.message}\n\n` +
        `Resubmit from the admin order page: ${baseUrl}/admin/order/${updatedOrder.admin_token}`
      );
    } catch (alertErr) {
      console.error(`Failed to send admin alert for order ${order.id}:`, alertErr.message);
    }
  }

  // 5. Tell the customer their tribute is being printed. Best-effort only.
  if (notifyCustomer && order.email) {
    try {
      const statusPageUrl = `${baseUrl}/order/${order.proof_token}`;
      await emailService.sendApprovalConfirmation(order.email, {
        orderId: order.id,
        totalCents: order.total_cents,
        templateName: order.template_id,
      }, statusPageUrl, noteFileUrl ? `${baseUrl}${noteFileUrl}` : null);
    } catch (err) {
      console.error(`Failed to send approval confirmation email for order ${order.id}:`, err.message);
    }
  }

  return { printFileUrl, noteFileUrl, provider, reference, fulfillmentError };
}

module.exports = { releaseToProduction };
