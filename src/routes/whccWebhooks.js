/**
 * WHCC Webhook Receiver
 * Handles order status updates: Processed (Accepted/Rejected) and Shipped.
 * Uses HMAC-SHA256 signature verification per WHCC docs:
 *   WHCC-Signature: t=<timestamp>,v1=<hex-hmac>
 *   Signed payload: "<timestamp>.<rawBody>"
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

/**
 * Parse WHCC-Signature header: "t=1591735205,v1=307D88AF..."
 * Returns { timestamp, signature } or null.
 */
function parseSignatureHeader(header) {
  if (!header) return null;
  const parts = {};
  for (const pair of header.split(',')) {
    const [key, ...rest] = pair.split('=');
    parts[key.trim()] = rest.join('=').trim();
  }
  return (parts.t && parts.v1)
    ? { timestamp: parts.t, signature: parts.v1 }
    : null;
}

/**
 * Verify WHCC webhook signature using HMAC-SHA256.
 * WHCC signs: "<timestamp>.<rawBody>" with consumer secret.
 */
function verifySignature(rawBody, signatureHeader) {
  const secret = process.env.WHCC_CONSUMER_SECRET;
  if (!secret) {
    console.warn('WHCC webhook: no consumer secret configured, skipping verification');
    return true;
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) return false;

  const payload = `${parsed.timestamp}.${rawBody}`;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .toUpperCase();

  try {
    return crypto.timingSafeEqual(
      Buffer.from(parsed.signature.toUpperCase(), 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

/**
 * Parse the raw body into an event object.
 * WHCC may send JSON or form-encoded data (docs are ambiguous).
 */
function parseBody(rawBody) {
  const str = rawBody.toString();

  // Try JSON first
  try {
    return JSON.parse(str);
  } catch { /* not JSON */ }

  // Try URL-encoded form data (verifier=abc-123&other=value)
  try {
    const params = new URLSearchParams(str);
    const obj = {};
    for (const [key, value] of params) {
      obj[key] = value;
    }
    if (Object.keys(obj).length > 0) return obj;
  } catch { /* not form-encoded */ }

  return null;
}

/**
 * POST /api/whcc-webhooks/callback
 * Receives order status events from WHCC.
 *
 * Note: This route expects raw body (configured in server.js via express.raw()).
 */
router.post('/callback', (req, res) => {
  const db = req.app.locals.db;
  const rawBody = req.body;

  const event = parseBody(rawBody);
  if (!event) {
    console.error('WHCC webhook: could not parse body:', rawBody?.toString()?.substring(0, 200));
    return res.status(400).json({ error: 'Could not parse body' });
  }

  console.log('WHCC webhook received:', JSON.stringify(event, null, 2));

  // Handle verification request from WHCC (sent during webhook registration)
  if (event.verifier) {
    console.log('WHCC webhook VERIFICATION CODE:', event.verifier);
    // Return 200 OK — WHCC just needs a successful response
    return res.status(200).send('OK');
  }

  // Verify HMAC signature on real events
  const signatureHeader = req.headers['whcc-signature'];
  if (!verifySignature(rawBody, signatureHeader)) {
    console.error('WHCC webhook: invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  try {
    // WHCC docs use "ConfirmationId" (lowercase d) and "Event" (not "EventType")
    const confirmationId = event.ConfirmationId || event.ConfirmationID || event.confirmationId;
    const eventType = event.Event || event.event || event.EventType || event.eventType;

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
        const reason = (event.Errors || []).map(e => e.Error || e.error).join('; ')
          || event.Reason || event.reason || 'Unknown reason';
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
      // Extract tracking from ShippingInfo array (per WHCC docs)
      const shipInfo = (event.ShippingInfo || [])[0] || {};
      const trackingNumber = shipInfo.TrackingNumber || event.TrackingNumber || '';
      const carrier = shipInfo.Carrier || event.Carrier || '';
      const trackingUrl = shipInfo.TrackingUrl || event.TrackingUrl || '';

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
