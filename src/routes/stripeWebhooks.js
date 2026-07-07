/**
 * Stripe Webhook Handler
 * Processes checkout.session.completed and checkout.session.expired events.
 * On successful payment: saves shipping, generates proof, and asks David/Rebecca
 * to review it. The customer proof email is only sent from the review page
 * (adminReview.js) — never from here.
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

  // Idempotency – don't process twice. Includes the terminal states
  // (delivered/cancelled) so a duplicate checkout.session.completed after a
  // digital order is delivered can't reset it and regenerate the proof_token
  // that the customer's download link is keyed on.
  if (['awaiting_review', 'proof_ready', 'proof_approved', 'change_requested', 'in_production', 'shipped', 'delivered', 'cancelled'].includes(order.status)) {
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

  // Generate proof token (customer-facing) + admin token (fulfillment actions).
  // These are deliberately separate — the customer link must never be able
  // to mark an order shipped.
  const proofToken = uuidv4();
  const adminToken = uuidv4();

  // Update order with payment + shipping info, set to awaiting_review:
  // a human approves every proof before the customer sees it.
  // Luma is the primary provider — default to it when the env var is unset
  // (WHCC creds are broken; stamping 'whcc' here would poison the order).
  let provider = process.env.FULFILLMENT_PROVIDER;
  if (!provider) {
    console.warn(`Stripe webhook: FULFILLMENT_PROVIDER not set — defaulting order ${orderId} to 'luma'`);
    provider = 'luma';
  }
  db.run(
    `UPDATE orders SET
       status = 'awaiting_review',
       stripe_payment_intent_id = ?,
       email = ?,
       shipping_json = COALESCE(?, shipping_json),
       proof_token = ?,
       admin_token = ?,
       fulfillment_provider = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
    [paymentIntentId, email, shippingJson, proofToken, adminToken, provider, orderId]
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

  // Step 1: send immediate order-confirmation email — don't make the customer wait for proof
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
  const statusPageUrl = `${baseUrl}/order/${proofToken}`;
  const emailService = require('../services/emailService');

  if (email) {
    try {
      const refreshed = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
      await emailService.sendOrderConfirmation(email, {
        orderId,
        templateName: refreshed.template_id,
        sku: refreshed.product_sku,
        totalCents: refreshed.total_cents,
      }, statusPageUrl);
      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [orderId, 'order_confirmation_sent', JSON.stringify({ email })]
      );
    } catch (err) {
      console.error(`Failed to send order confirmation for ${orderId}:`, err.message);
      // Non-fatal — proof email comes next anyway
    }
  }

  // Step 2: generate the proof and ask a human to review it.
  //
  // BRAND RULE: the proof email is NEVER sent to the customer automatically.
  // Every proof passes David/Rebecca's review first — the only path to
  // emailService.sendProofEmail runs through the approve action in
  // adminReview.js. Do not add a bypass flag, an env switch, or an
  // auto-send fallback here. This is a product promise, not a tech gap.
  try {
    const proofGenerator = require('../services/proofGenerator');
    const updatedOrder = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    const { proofRelativeUrl } = await proofGenerator.generateProof(updatedOrder);

    // Save proof URL to order
    db.run('UPDATE orders SET proof_url = ?, updated_at = datetime(\'now\') WHERE id = ?', [proofRelativeUrl, orderId]);

    const proofImageUrl = `${baseUrl}${proofRelativeUrl}`;
    const reviewUrl = `${baseUrl}/admin/review/${adminToken}`;

    await emailService.sendReviewRequest(
      db.get('SELECT * FROM orders WHERE id = ?', [orderId]),
      { reviewUrl, proofImageUrl }
    );

    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'review_requested', JSON.stringify({ proofUrl: proofRelativeUrl })]
    );

    console.log(`Order ${orderId}: proof generated — awaiting human review at /admin/review/${adminToken}`);
  } catch (err) {
    console.error(`Failed to generate proof for order ${orderId}:`, err.message);
    // Order is saved and paid — proof can be generated/sent manually
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'proof_generation_failed', JSON.stringify({ error: err.message })]
    );

    // Alert the admin — this order is paid and silently stalled otherwise
    try {
      const shortId = orderId.substring(0, 8).toUpperCase();
      await emailService.sendAdminAlert(
        `Order ${shortId} stalled: proof generation failed`,
        `Order ${shortId} is paid but its proof could not be generated.\n\n` +
        `Order ID: ${orderId}\n` +
        `Step: proof generation (Stripe webhook)\n` +
        `Error: ${err.message}\n\n` +
        `Review page: ${baseUrl}/admin/review/${adminToken}`
      );
    } catch (alertErr) {
      console.error(`Failed to send admin alert for order ${orderId}:`, alertErr.message);
    }
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
