/**
 * Stripe Webhook Handler
 * Processes checkout.session.completed and checkout.session.expired events.
 * On successful payment: saves shipping, updates order, triggers WHCC fulfillment.
 */

const express = require('express');
const router = express.Router();

/**
 * POST /api/stripe-webhooks
 * Receives events from Stripe. Expects raw body for signature verification.
 */
router.post('/', async (req, res) => {
  const db = req.app.locals.db;
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Stripe webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        await handleCheckoutCompleted(session, db);
        break;
      }

      case 'checkout.session.expired': {
        const session = event.data.object;
        handleCheckoutExpired(session, db);
        break;
      }

      default:
        console.log(`Stripe webhook: unhandled event type ${event.type}`);
    }
  } catch (err) {
    console.error('Stripe webhook processing error:', err);
    // Still return 200 to prevent Stripe from retrying
  }

  res.json({ received: true });
});

/**
 * Handle successful payment.
 */
async function handleCheckoutCompleted(session, db) {
  const orderId = session.metadata?.orderId;
  if (!orderId) {
    console.warn('Stripe webhook: no orderId in session metadata');
    return;
  }

  const order = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    console.warn(`Stripe webhook: order ${orderId} not found`);
    return;
  }

  // Idempotency — don't process twice
  if (order.status === 'submitted' || order.status === 'in_production' || order.status === 'shipped') {
    console.log(`Stripe webhook: order ${orderId} already processed (status: ${order.status})`);
    return;
  }

  console.log(`Stripe webhook: payment confirmed for order ${orderId}`);

  // Save payment details
  const paymentIntentId = session.payment_intent;
  const email = session.customer_details?.email || '';

  // Save shipping address
  const shippingDetails = session.shipping_details || session.shipping;
  let shippingJson = null;
  if (shippingDetails) {
    const addr = shippingDetails.address || {};
    shippingJson = JSON.stringify({
      name: shippingDetails.name || '',
      address1: addr.line1 || '',
      address2: addr.line2 || '',
      city: addr.city || '',
      state: addr.state || '',
      zip: addr.postal_code || '',
      country: addr.country || 'US',
    });
  }

  // Update order with payment + shipping info
  db.run(
    `UPDATE orders SET
       status = 'submitted',
       stripe_payment_intent_id = ?,
       email = ?,
       shipping_json = COALESCE(?, shipping_json),
       updated_at = datetime('now')
     WHERE id = ?`,
    [paymentIntentId, email, shippingJson, orderId]
  );

  // Log event
  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [orderId, 'payment_confirmed', JSON.stringify({
      stripeSessionId: session.id,
      paymentIntentId,
      email,
      amountTotal: session.amount_total,
    })]
  );

  // Submit to WHCC for printing
  try {
    const whccOrderApi = require('../services/whccOrderApi');
    const result = await whccOrderApi.placeOrder(orderId, db);
    console.log(`Order ${orderId} submitted to WHCC:`, result.confirmationId);
  } catch (err) {
    console.error(`Failed to submit order ${orderId} to WHCC:`, err.message);
    // Order is saved and paid — WHCC submission can be retried manually
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'whcc_submit_failed', JSON.stringify({ error: err.message })]
    );
  }
}

/**
 * Handle expired checkout session (customer abandoned).
 */
function handleCheckoutExpired(session, db) {
  const orderId = session.metadata?.orderId;
  if (!orderId) return;

  const order = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order || order.status !== 'pending_payment') return;

  db.run(
    `UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
    [orderId]
  );

  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [orderId, 'checkout_expired', JSON.stringify({ stripeSessionId: session.id })]
  );

  console.log(`Order ${orderId} cancelled (checkout expired)`);
}

module.exports = router;
