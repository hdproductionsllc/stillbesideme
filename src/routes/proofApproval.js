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

  // Submit to fulfillment provider
  const provider = order.fulfillment_provider || process.env.FULFILLMENT_PROVIDER || 'luma';

  try {
    if (provider === 'luma') {
      const lumaOrderApi = require('../services/lumaOrderApi');
      const result = await lumaOrderApi.placeOrder(order.id, db);
      console.log(`Proof approved — order ${order.id} submitted to Luma:`, result.orderNumber);
    } else {
      const whccOrderApi = require('../services/whccOrderApi');
      const result = await whccOrderApi.placeOrder(order.id, db);
      console.log(`Proof approved — order ${order.id} submitted to WHCC:`, result.confirmationId);
    }
  } catch (err) {
    console.error(`Failed to submit order ${order.id} to ${provider} after proof approval:`, err.message);
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [order.id, `${provider}_submit_failed`, JSON.stringify({ error: err.message })]
    );
    // Order is still saved as proof_approved — fulfillment can be retried manually
  }

  // Send approval confirmation email
  try {
    if (order.email) {
      const fields = order.fields_json ? JSON.parse(order.fields_json) : {};
      await emailService.sendApprovalConfirmation(order.email, {
        orderId: order.id,
        totalCents: order.total_cents,
        templateName: order.template_id,
      });
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

  // Notify admin
  try {
    await emailService.sendChangeRequestNotification(
      { orderId: order.id, email: order.email, templateName: order.template_id },
      notes
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
