/**
 * Admin Order Routes — tokenized fulfillment actions for partner-printed orders.
 *
 * The admin_token is generated alongside the proof_token at payment time and
 * lives only in the partner/admin fulfillment email. It is deliberately
 * separate from the customer-facing proof_token.
 *
 * GET  /api/admin/order/:token        — Order summary for the admin page
 * POST /api/admin/order/:token/ship   — Mark shipped + tracking → emails customer
 * POST /api/admin/order/:token/status — Manual status nudge (in_production)
 */

const express = require('express');
const router = express.Router();
const emailService = require('../services/emailService');

function findOrderByAdminToken(db, token) {
  if (!token || token.length < 8) return null;
  return db.get('SELECT * FROM orders WHERE admin_token = ?', [token]);
}

/**
 * GET /api/admin/order/:token
 */
router.get('/order/:token', (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByAdminToken(db, req.params.token);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};
  const shipping = order.shipping_json ? JSON.parse(order.shipping_json) : null;

  res.json({
    orderId: order.id,
    shortId: order.id.substring(0, 8).toUpperCase(),
    status: order.status,
    templateId: order.template_id,
    sku: order.product_sku,
    layout: fields.layout || null,
    colors: fields.colors || null,
    totalCents: order.total_cents,
    email: order.email,
    shipping,
    proofUrl: order.proof_url,
    printFileUrl: order.print_file_url,
    uvFileUrl: order.uv_file_url,
    tracking: order.tracking_number ? {
      number: order.tracking_number,
      carrier: order.tracking_carrier || '',
      url: order.tracking_url || '',
    } : null,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
  });
});

/**
 * POST /api/admin/order/:token/ship
 * Body: { trackingNumber, trackingCarrier?, trackingUrl? }
 * Idempotent — re-posting updates tracking without re-emailing the customer
 * unless ?resend=1 is passed.
 */
router.post('/order/:token/ship', async (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByAdminToken(db, req.params.token);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const trackingNumber = (req.body.trackingNumber || '').trim();
  const trackingCarrier = (req.body.trackingCarrier || '').trim();
  const trackingUrl = (req.body.trackingUrl || '').trim();

  if (!trackingNumber) {
    return res.status(400).json({ error: 'Tracking number is required' });
  }

  const alreadyShipped = order.status === 'shipped' || order.status === 'delivered';

  db.run(
    `UPDATE orders SET
       status = CASE WHEN status = 'delivered' THEN status ELSE 'shipped' END,
       tracking_number = ?, tracking_carrier = ?, tracking_url = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
    [trackingNumber, trackingCarrier, trackingUrl, order.id]
  );

  if (!alreadyShipped) {
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [order.id, 'partner_shipped', JSON.stringify({ trackingNumber, trackingCarrier, trackingUrl })]
    );
  }

  // Notify the customer (skipped on idempotent re-posts unless ?resend=1)
  let customerEmailed = false;
  if (order.email && (!alreadyShipped || req.query.resend === '1')) {
    try {
      const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
      const statusPageUrl = order.proof_token ? `${baseUrl}/order/${order.proof_token}` : null;
      await emailService.sendShippedEmail(order.email, { orderId: order.id }, {
        number: trackingNumber,
        carrier: trackingCarrier,
        url: trackingUrl,
      }, statusPageUrl);
      customerEmailed = true;
    } catch (err) {
      console.error(`Failed to send shipped email for order ${order.id}:`, err.message);
    }
  }

  res.json({
    success: true,
    message: alreadyShipped ? 'Tracking updated.' : 'Order marked shipped — customer notified.',
    customerEmailed,
  });
});

/**
 * POST /api/admin/order/:token/status
 * Body: { status: 'in_production' } — manual nudge only.
 */
router.post('/order/:token/status', (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByAdminToken(db, req.params.token);
  if (!order) {
    return res.status(404).json({ error: 'Order not found' });
  }

  const allowed = ['in_production'];
  const status = req.body.status;
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${allowed.join(', ')}` });
  }

  db.run(
    `UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?`,
    [status, order.id]
  );
  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [order.id, 'admin_status_change', JSON.stringify({ status })]
  );

  res.json({ success: true, status });
});

module.exports = router;
