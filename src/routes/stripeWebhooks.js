/**
 * Stripe Webhook Handler
 * Processes checkout.session.completed and checkout.session.expired events.
 * On successful payment: saves shipping, generates proof, emails customer for approval.
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

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

  // Idempotency – don't process twice
  if (['proof_ready', 'proof_approved', 'change_requested', 'in_production', 'shipped'].includes(order.status)) {
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

  // Generate proof token for approval URL
  const proofToken = uuidv4();

  // Update order with payment + shipping info, set to proof_ready (NOT submitted)
  const provider = process.env.FULFILLMENT_PROVIDER || 'whcc';
  db.run(
    `UPDATE orders SET
       status = 'proof_ready',
       stripe_payment_intent_id = ?,
       email = ?,
       shipping_json = COALESCE(?, shipping_json),
       proof_token = ?,
       fulfillment_provider = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
    [paymentIntentId, email, shippingJson, proofToken, provider, orderId]
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

  // Generate proof image and send email (non-blocking — order is safe even if this fails)
  try {
    const proofGenerator = require('../services/proofGenerator');
    const updatedOrder = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    const { proofRelativeUrl } = await proofGenerator.generateProof(updatedOrder);

    // Save proof URL to order
    db.run('UPDATE orders SET proof_url = ?, updated_at = datetime(\'now\') WHERE id = ?', [proofRelativeUrl, orderId]);

    // Send proof email
    const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
    const proofImageUrl = `${baseUrl}${proofRelativeUrl}`;
    const approvalPageUrl = `${baseUrl}/proof/${proofToken}`;

    const emailService = require('../services/emailService');
    await emailService.sendProofEmail(email, {
      orderId,
      templateName: updatedOrder.template_id,
      sku: updatedOrder.product_sku,
      totalCents: updatedOrder.total_cents,
    }, proofImageUrl, approvalPageUrl);

    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'proof_sent', JSON.stringify({ proofUrl: proofRelativeUrl, email })]
    );

    console.log(`Order ${orderId}: proof generated and emailed to ${email}`);
  } catch (err) {
    console.error(`Failed to generate/send proof for order ${orderId}:`, err.message);
    // Order is saved and paid — proof can be generated/sent manually
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'proof_generation_failed', JSON.stringify({ error: err.message })]
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
