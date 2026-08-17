/**
 * Luma Prints Webhook Receiver
 * Handles shipping event notifications from Luma.
 * Luma fires a `shipping` webhook with tracking info when an order ships.
 */

const express = require('express');
const router = express.Router();

/**
 * A clickable tracking link, built from the carrier when the printer sends a
 * bare number. Luma sends the number and the carrier name but no URL, and a
 * grieving customer should not have to copy a 22-digit string into a search
 * engine to find out where their parcel is.
 *
 * Unknown carrier returns '' rather than a guess: the status page and the
 * email both fall back to showing the plain number, which is honest, whereas
 * a wrong link is worse than no link.
 */
function trackingUrlFor(carrier, number) {
  if (!number) return '';
  const c = String(carrier || '').toLowerCase();
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(number)}`;
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${encodeURIComponent(number)}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(number)}`;
  if (c.includes('dhl')) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(number)}`;
  return '';
}

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

    // Extract tracking info.
    //
    // Luma nests it in a `shipments` array, one entry per parcel:
    //   { orderNumber, externalId,
    //     shipments: [{ carrier, shippingMethod, trackingNumber, shipmentDate,
    //                   items: [...] }] }
    //
    // This used to read event.trackingNumber at the top level, where nothing
    // has ever lived. The order flipped to shipped, the customer got their
    // "it's on its way" email, and the tracking line was silently blank —
    // proven on the first real order, which shipped with USPS tracking Luma
    // had sent us all along. Top-level keys are kept as a fallback in case a
    // future event shape is flatter.
    const shipment = Array.isArray(event.shipments) && event.shipments.length
      ? event.shipments[0]
      : {};
    const trackingNumber = shipment.trackingNumber || shipment.TrackingNumber
      || event.trackingNumber || event.TrackingNumber || '';
    const carrier = shipment.carrier || shipment.Carrier
      || event.carrier || event.Carrier || '';
    const trackingUrl = shipment.trackingUrl || shipment.TrackingUrl
      || event.trackingUrl || event.TrackingUrl
      || trackingUrlFor(carrier, trackingNumber);

    if (!trackingNumber) {
      console.warn(
        `Luma webhook: order ${orderNumber} shipped with NO tracking number. `
        + `Payload keys: ${Object.keys(event).join(', ')}`
      );
    }

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

    // Do not tell a customer their parcel is on its way and then give them no
    // way to find it. Luma always sends a tracking number with a shipment, so
    // its absence means we failed to read the payload, not that the parcel has
    // none — which is exactly what happened on the first real order: the email
    // went out, the tracking line was blank, and nothing anywhere complained.
    //
    // Holding the email converts a silent customer-facing defect into a loud
    // internal one. Nothing is lost by waiting: the send is guarded by the
    // shipped_email_sent event, so the moment a webhook arrives carrying
    // tracking, the customer gets a complete notice instead of a useless one.
    if (!alreadyEmailed && !trackingNumber) {
      console.error(
        `Luma webhook: HOLDING shipped email for order ${orderId} — the event `
        + `carried no tracking number. Payload keys: ${Object.keys(event).join(', ')}`
      );
      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [orderId, 'shipped_without_tracking', JSON.stringify({ payloadKeys: Object.keys(event) })]
      );
      try {
        const emailService = require('../services/emailService');
        await emailService.sendAdminAlert(
          `Shipped webhook had no tracking — order ${orderId}`,
          `Luma marked order ${orderId} (Luma #${orderNumber}) as shipped, but the\n`
          + `webhook carried no tracking number, so the customer email is being HELD.\n\n`
          + `Payload keys: ${Object.keys(event).join(', ')}\n\n`
          + `This almost always means Luma changed the payload shape. Check the raw\n`
          + `webhook log, fix the parse, then re-deliver the webhook or backfill.`
        );
      } catch (err) {
        console.error('Could not send ops alert for missing tracking:', err.message);
      }
    }

    const order = (alreadyEmailed || !trackingNumber)
      ? null
      : db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
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
