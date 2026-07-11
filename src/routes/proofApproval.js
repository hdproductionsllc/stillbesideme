/**
 * Proof Approval Routes
 *
 * GET  /api/proof/:token/data      — Returns order data + proof image URL
 * POST /api/proof/:token/approve   — Customer approves, triggers fulfillment
 * POST /api/proof/:token/request-changes — Customer requests changes
 */

const express = require('express');
const router = express.Router();
const emailService = require('../services/emailService');

const VALID_PROOF_STATUSES = ['proof_ready', 'change_requested'];

/**
 * Resolve the customer's chosen frame from the template so the approval
 * page can draw it around the proof (the proof image itself is frameless).
 * Returns { id, label, molding, faceIn } or null for unframed products.
 */
function resolveFrameForDisplay(templateId, fields, sku) {
  if (typeof sku !== 'string' || !sku.startsWith('framed-')) return null;
  try {
    const template = require('../services/tributeRenderer').loadTemplate(templateId);
    const fo = template && template.frameOptions;
    if (!fo || !Array.isArray(fo.groups)) return null;
    const all = fo.groups.reduce((acc, g) => acc.concat(g.choices || []), []);
    const chosen = all.find(c => c.id === (fields && fields.frameChoice))
      || all.find(c => c.id === fo.default)
      || all[0];
    if (!chosen) return null;
    return { id: chosen.id, label: chosen.label || chosen.id, molding: chosen.molding || null, faceIn: chosen.faceIn || 0.875 };
  } catch (err) {
    return null;
  }
}

/** Look up an order by proof token and validate status. */
function findOrderByToken(db, token) {
  if (!token || token.length < 8) return null;
  return db.get('SELECT * FROM orders WHERE proof_token = ?', [token]);
}

/**
 * GET /api/proof/:token/data
 * Returns order summary + proof image for the approval page.
 */
router.get('/:token/data', (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByToken(db, req.params.token);

  if (!order) {
    return res.status(404).json({ error: 'Proof not found' });
  }

  if (!VALID_PROOF_STATUSES.includes(order.status) && order.status !== 'proof_approved') {
    return res.status(410).json({ error: 'This proof is no longer available' });
  }

  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};
  const shipping = order.shipping_json ? JSON.parse(order.shipping_json) : null;

  res.json({
    orderId: order.id,
    status: order.status,
    templateId: order.template_id,
    sku: order.product_sku,
    totalCents: order.total_cents,
    email: order.email,
    proofUrl: order.proof_url,
    shipping,
    style: fields.style,
    // Chosen frame (null for print-only/digital) — lets the approval page
    // draw the frame around the frameless proof image.
    frame: resolveFrameForDisplay(order.template_id, fields, order.product_sku),
    name: fields[getNameField(order.template_id, fields)] || '',
    changeRequestNotes: order.change_request_notes || null,
    createdAt: order.created_at,
  });
});

/**
 * POST /api/proof/:token/approve
 * Customer approves the proof — triggers fulfillment.
 */
router.post('/:token/approve', async (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByToken(db, req.params.token);

  if (!order) {
    return res.status(404).json({ error: 'Proof not found' });
  }

  if (!VALID_PROOF_STATUSES.includes(order.status)) {
    if (order.status === 'proof_approved' || order.status === 'in_production') {
      return res.json({ success: true, message: 'This proof has already been approved' });
    }
    return res.status(400).json({ error: 'This proof cannot be approved in its current state' });
  }

  // Update status to proof_approved
  db.run(
    `UPDATE orders SET status = 'proof_approved', proof_approved_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    [order.id]
  );

  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [order.id, 'proof_approved', JSON.stringify({ approvedAt: new Date().toISOString() })]
  );

  // Generate print-ready file (full-resolution composite, no watermark)
  const printRenderer = require('../services/printRenderer');
  try {
    const { printRelativeUrl } = await printRenderer.generatePrintFile(order);
    db.run('UPDATE orders SET print_file_url = ?, updated_at = datetime(\'now\') WHERE id = ?',
      [printRelativeUrl, order.id]);
    console.log(`Print-ready file generated for order ${order.id}: ${printRelativeUrl}`);
  } catch (err) {
    console.error(`Failed to generate print-ready file for order ${order.id}:`, err.message);
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [order.id, 'print_render_failed', JSON.stringify({ error: err.message })]
    );

    // Alert the admin — the customer approved but nothing can print
    try {
      const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
      const shortId = order.id.substring(0, 8).toUpperCase();
      await emailService.sendAdminAlert(
        `Order ${shortId} stalled: print render failed`,
        `Order ${shortId} was approved by the customer but the print-ready file could not be generated.\n\n` +
        `Order ID: ${order.id}\n` +
        `Step: print render (proof approval)\n` +
        `Error: ${err.message}\n\n` +
        `Review page: ${baseUrl}/admin/review/${order.admin_token}`
      );
    } catch (alertErr) {
      console.error(`Failed to send admin alert for order ${order.id}:`, alertErr.message);
    }

    return res.status(500).json({ error: 'Failed to generate your print file. Our team has been notified.' });
  }

  // Submit to fulfillment provider (shared with the admin resubmit route)
  const { submitFulfillment, resolveProvider } = require('../services/fulfillmentSubmitter');
  // Re-fetch order so the submitter sees print_file_url
  const updatedOrder = db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
  const provider = resolveProvider(updatedOrder);

  try {
    const result = await submitFulfillment(updatedOrder, db);
    console.log(`Proof approved — order ${order.id} submitted to ${result.provider}${result.reference ? `: ${result.reference}` : ''}`);
  } catch (err) {
    console.error(`Failed to submit order ${order.id} to ${provider} after proof approval:`, err.message);
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [order.id, `${provider}_submit_failed`, JSON.stringify({ error: err.message })]
    );
    // Order is still saved as proof_approved — fulfillment can be retried
    // from the admin order page (Resubmit fulfillment button).

    try {
      const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
      const shortId = order.id.substring(0, 8).toUpperCase();
      await emailService.sendAdminAlert(
        `Order ${shortId} stalled: ${provider} submit failed`,
        `Order ${shortId} was approved by the customer but could not be submitted to ${provider}.\n\n` +
        `Order ID: ${order.id}\n` +
        `Step: fulfillment submit (proof approval)\n` +
        `Error: ${err.message}\n\n` +
        `Resubmit from the admin order page: ${baseUrl}/admin/order/${order.admin_token}`
      );
    } catch (alertErr) {
      console.error(`Failed to send admin alert for order ${order.id}:`, alertErr.message);
    }
  }

  // Send approval confirmation email
  try {
    if (order.email) {
      const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
      const statusPageUrl = `${baseUrl}/order/${order.proof_token}`;
      await emailService.sendApprovalConfirmation(order.email, {
        orderId: order.id,
        totalCents: order.total_cents,
        templateName: order.template_id,
      }, statusPageUrl);
    }
  } catch (err) {
    console.error(`Failed to send approval confirmation email for order ${order.id}:`, err.message);
  }

  res.json({ success: true, message: 'Your tribute has been approved and is now being printed!' });
});

/**
 * POST /api/proof/:token/request-changes
 * Customer requests changes to their proof.
 */
router.post('/:token/request-changes', async (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByToken(db, req.params.token);

  if (!order) {
    return res.status(404).json({ error: 'Proof not found' });
  }

  if (!VALID_PROOF_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: 'Changes cannot be requested for this proof' });
  }

  const notes = (req.body.notes || '').trim();
  if (!notes) {
    return res.status(400).json({ error: 'Please describe the changes you would like' });
  }

  // Update status
  db.run(
    `UPDATE orders SET status = 'change_requested', change_request_notes = ?, updated_at = datetime('now') WHERE id = ?`,
    [notes, order.id]
  );

  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [order.id, 'change_requested', JSON.stringify({ notes })]
  );

  // Notify admin with a direct link to the review page (edit poem, regenerate, resend)
  try {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
    await emailService.sendChangeRequestNotification(
      { orderId: order.id, email: order.email, templateName: order.template_id },
      notes,
      order.admin_token ? `${baseUrl}/admin/review/${order.admin_token}` : null
    );
  } catch (err) {
    console.error(`Failed to send change request notification for order ${order.id}:`, err.message);
  }

  res.json({ success: true, message: 'Your change request has been sent. We\'ll update your proof and email you when it\'s ready.' });
});

/** Resolve the "name" field key from template mapping. */
function getNameField(templateId, fields) {
  const mappings = {
    'pet-tribute': 'petName',
    'letter-from-heaven': 'name',
  };
  return mappings[templateId] || 'name';
}

module.exports = router;
