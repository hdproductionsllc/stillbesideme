/**
 * Luma Prints Webhook Receiver
 * Handles shipping event notifications from Luma.
 * Luma fires a `shipping` webhook with tracking info when an order ships.
 */

const express = require('express');
const router = express.Router();

/**
 * GET /api/luma-webhooks
 * Reachability check — Luma pings the URL with a GET when registering the
 * webhook and needs a 200 before it will accept the subscription.
 */
router.get('/', (req, res) => {
  res.status(200).json({ ok: true, service: 'luma-webhook' });
});

/**
 * POST /api/luma-webhooks
 * Receives shipping events from Luma Prints.
 * Raw body is parsed here (configured in server.js via express.raw()).
 */
router.post('/', async (req, res) => {
  const db = req.app.locals.db;

  let event;
  try {
    const raw = req.body instanceof Buffer ? req.body.toString() : req.body;
    event = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    console.error('Luma webhook: could not parse body:', err.message);
    return res.status(400).json({ error: 'Could not parse body' });
  }

  console.log('Luma webhook received:', JSON.stringify(event, null, 2));

  try {
    const orderNumber = event.orderNumber || event.OrderNumber;
    if (!orderNumber) {
      console.warn('Luma webhook: no orderNumber in payload');
      return res.json({ received: true, warning: 'no orderNumber' });
    }

    // Find our tracked order
    const lumaOrder = db.get(
      'SELECT * FROM luma_orders WHERE luma_order_number = ?',
      [String(orderNumber)]
    );

    if (!lumaOrder) {
      console.warn(`Luma webhook: unknown order number ${orderNumber}`);
      return res.json({ received: true, warning: 'unknown order' });
    }

    const orderId = lumaOrder.order_id;

    // Extract tracking info
    const trackingNumber = event.trackingNumber || event.TrackingNumber || '';
    const carrier = event.carrier || event.Carrier || '';
    const trackingUrl = event.trackingUrl || event.TrackingUrl || '';

    // Update luma_orders
    db.run(
      `UPDATE luma_orders SET status = 'shipped', tracking_number = ?,
       tracking_carrier = ?, tracking_url = ?, updated_at = datetime('now')
       WHERE luma_order_number = ?`,
      [trackingNumber, carrier, trackingUrl, String(orderNumber)]
    );

    // Update main order
    db.run(
      `UPDATE orders SET status = 'shipped', updated_at = datetime('now')
       WHERE id = ?`,
      [orderId]
    );

    // Log event
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'luma_shipped', JSON.stringify(event)]
    );

    // Tell the customer their tribute shipped — the email both the order
    // confirmation and the being-printed email promised. Luma has no customer
    // email (their order carries only our account address), so this is the
    // only shipping notice the customer will ever get. Best-effort: a mail
    // failure must not make Luma retry the webhook.
    // Send it once and only once. Luma re-delivers any webhook it believes
    // failed, and a store can carry more than one subscription for the same
    // event, so this handler must expect to run twice for one shipment. The
    // database columns above are safe to rewrite with identical values; an
    // email is not — a grieving customer receiving two "your tribute has
    // shipped" notices reads it as an order gone wrong.
    const alreadyEmailed = db.get(
      `SELECT 1 FROM order_events WHERE order_id = ? AND event_type = 'shipped_email_sent' LIMIT 1`,
      [orderId]
    );
    if (alreadyEmailed) {
      console.log(`Luma webhook: shipped email already sent for order ${orderId} — skipping duplicate`);
    }

    const order = alreadyEmailed ? null : db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    if (order && order.email) {
      try {
        const emailService = require('../services/emailService');
        const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
        const statusPageUrl = order.proof_token ? `${baseUrl}/order/${order.proof_token}` : null;
        await emailService.sendShippedEmail(order.email, { orderId }, {
          number: trackingNumber,
          carrier,
          url: trackingUrl,
        }, statusPageUrl);
        db.run(
          `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
          [orderId, 'shipped_email_sent', JSON.stringify({ email: order.email, trackingNumber })]
        );
      } catch (err) {
        console.error(`Failed to send shipped email for order ${orderId}:`, err.message);
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Luma webhook processing error:', err);
    res.status(500).json({ error: 'Internal error processing webhook' });
  }
});

module.exports = router;
