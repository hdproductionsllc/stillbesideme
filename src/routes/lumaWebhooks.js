/**
 * Luma Prints Webhook Receiver
 * Handles shipping event notifications from Luma.
 * Luma fires a `shipping` webhook with tracking info when an order ships.
 */

const express = require('express');
const router = express.Router();

/**
 * POST /api/luma-webhooks
 * Receives shipping events from Luma Prints.
 * Raw body is parsed here (configured in server.js via express.raw()).
 */
router.post('/', (req, res) => {
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

    res.json({ received: true });
  } catch (err) {
    console.error('Luma webhook processing error:', err);
    res.status(500).json({ error: 'Internal error processing webhook' });
  }
});

module.exports = router;
