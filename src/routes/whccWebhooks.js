/**
 * WHCC Webhook Receiver
 * Handles order status updates: Processed (Accepted/Rejected) and Shipped.
 * Uses HMAC-SHA256 signature verification.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

/**
 * Verify WHCC webhook signature using HMAC-SHA256.
 * WHCC sends the signature in the WHCC-Signature header.
 */
function verifySignature(rawBody, signature) {
  const secret = process.env.WHCC_CONSUMER_SECRET;
  if (!secret) {
    console.warn('WHCC webhook: no consumer secret configured, skipping verification');
    return true;
  }
  if (!signature) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * POST /api/whcc-webhooks/callback
 * Receives order status events from WHCC.
 *
 * Note: This route expects raw body (configured in server.js via express.raw()).
 */
router.post('/callback', (req, res) => {
  const db = req.app.locals.db;
  const signature = req.headers['whcc-signature'];
  const rawBody = req.body;

  // Verify signature
  if (!verifySignature(rawBody, signature)) {
    console.error('WHCC webhook: invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString());
  } catch (err) {
    console.error('WHCC webhook: invalid JSON', err);
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log('WHCC webhook received:', JSON.stringify(event, null, 2));

  try {
    const confirmationId = event.ConfirmationId || event.confirmationId;
    const eventType = event.EventType || event.eventType || event.Type || event.type;

    if (!confirmationId) {
      console.warn('WHCC webhook: no ConfirmationId in payload');
      return res.json({ received: true, warning: 'no ConfirmationId' });
    }

    // Find our tracked order
    const whccOrder = db.get(
      'SELECT * FROM whcc_orders WHERE confirmation_id = ?',
      [String(confirmationId)]
    );

    if (!whccOrder) {
      console.warn(`WHCC webhook: unknown ConfirmationId ${confirmationId}`);
      return res.json({ received: true, warning: 'unknown order' });
    }

    const orderId = whccOrder.order_id;

    if (eventType === 'Processed' || eventType === 'processed') {
      const status = event.Status || event.status;

      if (status === 'Accepted' || status === 'accepted') {
        // Order accepted by WHCC for production
        db.run(
          `UPDATE whcc_orders SET status = 'accepted', updated_at = datetime('now')
           WHERE confirmation_id = ?`,
          [String(confirmationId)]
        );
        db.run(
          `UPDATE orders SET status = 'in_production', updated_at = datetime('now')
           WHERE id = ?`,
          [orderId]
        );
      } else if (status === 'Rejected' || status === 'rejected') {
        // Order rejected — needs investigation
        const reason = event.Reason || event.reason || 'Unknown reason';
        db.run(
          `UPDATE whcc_orders SET status = 'rejected', error_message = ?,
           updated_at = datetime('now') WHERE confirmation_id = ?`,
          [reason, String(confirmationId)]
        );
        db.run(
          `UPDATE orders SET status = 'cancelled', updated_at = datetime('now')
           WHERE id = ?`,
          [orderId]
        );
      }

      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [orderId, `whcc_${(status || 'unknown').toLowerCase()}`, JSON.stringify(event)]
      );
    } else if (eventType === 'Shipped' || eventType === 'shipped') {
      // Order shipped — extract tracking info
      const trackingNumber = event.TrackingNumber || event.trackingNumber || '';
      const carrier = event.Carrier || event.carrier || '';
      const trackingUrl = event.TrackingUrl || event.trackingUrl || '';

      db.run(
        `UPDATE whcc_orders SET status = 'shipped', tracking_number = ?,
         tracking_carrier = ?, tracking_url = ?, updated_at = datetime('now')
         WHERE confirmation_id = ?`,
        [trackingNumber, carrier, trackingUrl, String(confirmationId)]
      );

      db.run(
        `UPDATE orders SET status = 'shipped', updated_at = datetime('now')
         WHERE id = ?`,
        [orderId]
      );

      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [orderId, 'whcc_shipped', JSON.stringify(event)]
      );
    } else {
      // Unknown event type — log it anyway
      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [orderId, `whcc_webhook_${eventType || 'unknown'}`, JSON.stringify(event)]
      );
    }

    res.json({ received: true });
  } catch (err) {
    console.error('WHCC webhook processing error:', err);
    res.status(500).json({ error: 'Internal error processing webhook' });
  }
});

module.exports = router;
