/**
 * Fulfillment Submitter — the single path from an approved proof to a
 * provider order. Shared by proofApproval.js (customer approves) and
 * adminOrder.js (manual resubmit) so the two flows never drift apart.
 *
 * Providers:
 *   'partner' — email the print file + specs to the partner print shop
 *   'luma'    — Luma Prints REST API (primary)
 *   'whcc'    — WHCC Order API (legacy fallback)
 */

const emailService = require('./emailService');

/** Resolve the provider for an order. Luma is the default when nothing is set. */
function resolveProvider(order) {
  return order.fulfillment_provider || process.env.FULFILLMENT_PROVIDER || 'luma';
}

/**
 * True when the order already has a live fulfillment submission on record
 * (a Luma or WHCC row that is not a dead pending/error/rejected attempt).
 * Used by the resubmit endpoint to stay idempotent.
 */
function hasFulfillmentRecord(db, orderId) {
  const luma = db.get(
    `SELECT id FROM luma_orders
     WHERE order_id = ? AND status IN ('submitted', 'processing', 'shipped')
     LIMIT 1`,
    [orderId]
  );
  if (luma) return true;

  const whcc = db.get(
    `SELECT id FROM whcc_orders
     WHERE order_id = ? AND status IN ('imported', 'submitted', 'accepted', 'shipped')
     LIMIT 1`,
    [orderId]
  );
  return !!whcc;
}

/**
 * Submit an order to its fulfillment provider.
 * The order row must already have print_file_url set. Throws on failure;
 * callers log the `${provider}_submit_failed` event and alert the admin.
 *
 * Returns { provider, reference } where reference is the provider's order
 * number/confirmation id (null for the partner email flow).
 */
async function submitFulfillment(order, db) {
  const provider = resolveProvider(order);

  if (provider === 'partner') {
    // Partner print shop: email them the print file + order details
    // with a tokenized admin link to mark the order shipped.
    const path = require('path');
    const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
    const outputRoot = process.env.OUTPUT_DIR || path.join(__dirname, '..', '..', 'output');

    await emailService.sendPartnerOrderEmail(order, {
      printFileUrl: `${baseUrl}${order.print_file_url}`,
      printFilePath: path.join(outputRoot, 'print-ready', `${order.id}.jpg`),
      adminUrl: `${baseUrl}/admin/order/${order.admin_token}`,
      proofImageUrl: order.proof_url ? `${baseUrl}${order.proof_url}` : null,
    });

    db.run(
      `UPDATE orders SET status = 'in_production', updated_at = datetime('now') WHERE id = ?`,
      [order.id]
    );
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [order.id, 'partner_order_sent', JSON.stringify({ sentAt: new Date().toISOString() })]
    );
    return { provider, reference: null };
  }

  if (provider === 'luma') {
    const lumaOrderApi = require('./lumaOrderApi');
    const result = await lumaOrderApi.placeOrder(order.id, db);
    return { provider, reference: result.orderNumber };
  }

  const whccOrderApi = require('./whccOrderApi');
  const result = await whccOrderApi.placeOrder(order.id, db);
  return { provider, reference: result.confirmationId };
}

module.exports = { submitFulfillment, resolveProvider, hasFulfillmentRecord };
