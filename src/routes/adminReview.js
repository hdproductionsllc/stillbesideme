/**
 * Admin Review Routes — the human gate between payment and the customer
 * proof email.
 *
 * BRAND RULE: every proof passes David/Rebecca's review before the customer
 * sees it. The approve action below is the ONLY caller of sendProofEmail.
 * Never add an automatic path around this page.
 *
 * Uses the same tokenized model as adminOrder.js (admin_token, generated at
 * payment, deliberately separate from the customer-facing proof_token).
 *
 * GET  /api/admin/review/:token/data     — Order + answers + poem + proof
 * POST /api/admin/review/:token/poem     — Save edited poem, regenerate proof
 * POST /api/admin/review/:token/approve  — Send the proof email to the customer
 *
 * Handles both fresh orders (awaiting_review) and customer change requests
 * (change_requested) — same page, same actions.
 */

const express = require('express');
const router = express.Router();
const emailService = require('../services/emailService');
const { frameInscription } = require('../services/uvFrameRenderer');

const REVIEWABLE_STATUSES = ['awaiting_review', 'change_requested'];

function findOrderByAdminToken(db, token) {
  if (!token || token.length < 8) return null;
  return db.get('SELECT * FROM orders WHERE admin_token = ?', [token]);
}

/**
 * GET /api/admin/review/:token/data
 */
router.get('/review/:token/data', (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByAdminToken(db, req.params.token);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};

  res.json({
    orderId: order.id,
    shortId: order.id.substring(0, 8).toUpperCase(),
    status: order.status,
    reviewable: REVIEWABLE_STATUSES.includes(order.status),
    templateId: order.template_id,
    sku: order.product_sku,
    totalCents: order.total_cents,
    email: order.email,
    poemText: order.poem_text || '',
    proofUrl: order.proof_url,
    frameText: frameInscription(fields),
    fields,
    changeRequestNotes: order.change_request_notes || null,
    reviewedAt: order.reviewed_at || null,
    createdAt: order.created_at,
  });
});

/**
 * POST /api/admin/review/:token/poem
 * Body: { poemText } — saves the edit and regenerates the proof image.
 */
router.post('/review/:token/poem', async (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByAdminToken(db, req.params.token);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  if (!REVIEWABLE_STATUSES.includes(order.status)) {
    return res.status(400).json({ error: `Order is ${order.status.replace(/_/g, ' ')} — the poem can no longer be edited here` });
  }

  const poemText = (req.body.poemText || '').trim();
  if (!poemText) {
    return res.status(400).json({ error: 'Poem text cannot be empty' });
  }

  db.run(
    `UPDATE orders SET poem_text = ?, updated_at = datetime('now') WHERE id = ?`,
    [poemText, order.id]
  );

  // Regenerate the proof so the review (and later the customer) sees the edit
  try {
    const proofGenerator = require('../services/proofGenerator');
    const updatedOrder = db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
    const { proofRelativeUrl } = await proofGenerator.generateProof(updatedOrder);
    db.run('UPDATE orders SET proof_url = ?, updated_at = datetime(\'now\') WHERE id = ?', [proofRelativeUrl, order.id]);

    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [order.id, 'poem_edited', JSON.stringify({ proofUrl: proofRelativeUrl })]
    );

    res.json({ success: true, message: 'Poem saved — proof regenerated.', proofUrl: proofRelativeUrl });
  } catch (err) {
    console.error(`Failed to regenerate proof for order ${order.id}:`, err.message);
    res.status(500).json({ error: 'Poem was saved, but the proof failed to regenerate. Try again.' });
  }
});

/**
 * POST /api/admin/review/:token/approve
 * The gate opens: sends the proof email to the customer.
 * Idempotent — re-posting after approval does not re-email unless ?resend=1.
 */
router.post('/review/:token/approve', async (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByAdminToken(db, req.params.token);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const alreadySent = order.status === 'proof_ready';
  if (!REVIEWABLE_STATUSES.includes(order.status) && !alreadySent) {
    return res.status(400).json({ error: `Order is ${order.status.replace(/_/g, ' ')} — nothing to approve` });
  }
  if (alreadySent && req.query.resend !== '1') {
    return res.json({ success: true, message: 'Proof was already sent to the customer.' });
  }

  if (!order.email) {
    return res.status(400).json({ error: 'Order has no customer email — cannot send the proof' });
  }
  if (!order.proof_url) {
    return res.status(400).json({ error: 'No proof image on this order yet — save the poem to generate one' });
  }

  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};

  try {
    await emailService.sendProofEmail(order.email, {
      orderId: order.id,
      templateName: order.template_id,
      sku: order.product_sku,
      totalCents: order.total_cents,
      frameText: frameInscription(fields),
    },
    `${baseUrl}${order.proof_url}`,
    `${baseUrl}/proof/${order.proof_token}`,
    `${baseUrl}/order/${order.proof_token}`);
  } catch (err) {
    console.error(`Failed to send proof email for order ${order.id}:`, err.message);
    return res.status(500).json({ error: 'Could not send the proof email. Check SMTP settings and try again.' });
  }

  db.run(
    `UPDATE orders SET
       status = 'proof_ready',
       reviewed_at = datetime('now'),
       change_request_notes = NULL,
       updated_at = datetime('now')
     WHERE id = ?`,
    [order.id]
  );
  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [order.id, 'review_approved', JSON.stringify({ resend: alreadySent })]
  );
  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [order.id, 'proof_sent', JSON.stringify({ proofUrl: order.proof_url, email: order.email })]
  );

  console.log(`Order ${order.id}: review approved — proof emailed to ${order.email}`);
  res.json({ success: true, message: 'Approved — proof emailed to the customer.' });
});

module.exports = router;
