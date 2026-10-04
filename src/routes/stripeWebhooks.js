/**
 * Stripe Webhook Handler
 * Processes the Checkout Session lifecycle:
 *   checkout.session.completed               paid (card), or created-but-unpaid
 *                                            for delayed methods
 *   checkout.session.async_payment_succeeded the delayed payment cleared
 *   checkout.session.async_payment_failed    the delayed payment did not clear
 *   checkout.session.expired                 customer abandoned
 * On confirmed payment: saves shipping and asks David/Rebecca to review the
 * proof internally.
 *
 * The customer has ALREADY approved their proof, inline, before paying (see
 * src/routes/checkout.js) — so nothing here, and nothing downstream, asks them
 * to approve anything again. The proof they approved is preserved untouched:
 * it is the evidence behind the payment, so this handler will not re-render
 * over it.
 *
 * Money only moves an order forward when the session that paid is the session
 * the order is waiting on, for the amount the order was priced at. See
 * handleCheckoutCompleted for why that is not a formality.
 */

const express = require('express');
const router = express.Router();
const { acceptOrder, parsePetDate } = require('../services/orderAcceptance');

// Statuses a paid session can no longer move. Includes 'delivered' so a
// duplicate checkout.session.completed after a digital order is delivered
// can't reset it and regenerate the proof_token that the customer's download
// link is keyed on.
//
// 'cancelled' is deliberately NOT here. A payment landing on a cancelled
// order is not a duplicate, it is money taken for something we told the
// customer was off. It falls through to the mismatch branch below, which
// alerts a human instead of returning a quiet 200.
const ALREADY_PAID_STATUSES = [
  'awaiting_review', 'proof_ready', 'proof_approved', 'change_requested',
  'in_production', 'shipped', 'delivered',
];

/**
 * POST /api/stripe-webhooks
 * Receives events from Stripe. Expects raw body for signature verification.
 *
 * Response codes are a contract with Stripe's retry loop:
 *   200  handled, or deliberately skipped (an order we do not know, which on
 *        this shared Stripe account is usually a sibling brand's, or a
 *        duplicate). Nothing a retry could change.
 *   400  bad signature. Never ours to retry.
 *   500  something threw mid-way. Stripe retries for up to three days, which
 *        is exactly what a paid order with a half-written row needs.
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

  const session = event.data.object;

  try {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutCompleted(session, db);
        break;

      case 'checkout.session.async_payment_failed':
        await handleAsyncPaymentFailed(session, db);
        break;

      case 'checkout.session.expired':
        await handleCheckoutExpired(session, db);
        break;

      default:
        console.log(`Stripe webhook: unhandled event type ${event.type}`);
    }
  } catch (err) {
    console.error('Stripe webhook processing error:', err);
    return res.status(500).json({ error: 'Webhook processing failed; Stripe will retry.' });
  }

  res.json({ received: true });
});

/**
 * Handle a completed Checkout Session.
 *
 * Reached from checkout.session.completed and, for delayed payment methods
 * (bank debits and the like), again from async_payment_succeeded once the
 * money actually clears. The same checks run both times; only a session that
 * is paid, current, and priced as the order expects advances anything.
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

  // Idempotency: don't process twice.
  if (ALREADY_PAID_STATUSES.includes(order.status)) {
    console.log(`Stripe webhook: order ${orderId} already processed (status: ${order.status})`);
    return;
  }

  // A completed session is not necessarily a paid one. Delayed methods
  // complete the session first and settle later, at which point Stripe sends
  // async_payment_succeeded (or _failed) and we come back through here. Until
  // then the order is a promise, not a payment, and it stays pending.
  //
  // The test is 'unpaid' rather than 'not paid', which is Stripe's own
  // fulfilment rule. payment_status has exactly three values: paid, unpaid,
  // and no_payment_required. The third is what a session worth $0 reports,
  // so a 100% promotion code (a free test order, or a friends and family
  // code) is a real order that simply has no payment_intent behind it.
  // Treating it as unpaid would strand it in pending_payment forever.
  if (session.payment_status === 'unpaid') {
    console.log(`Stripe webhook: order ${orderId} session ${session.id} completed but payment_status is "${session.payment_status}", waiting`);
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'payment_pending', JSON.stringify({
        stripeSessionId: session.id,
        paymentStatus: session.payment_status || null,
        paymentIntentId: session.payment_intent || null,
      })]
    );
    return;
  }

  // The session that paid must be the session this order is waiting on, for
  // the amount the order was priced at. One order row lives through a whole
  // customize, proof, edit, proof, pay journey (see findOpenSessionOrder in
  // checkout.js), and each edit rewrites the SKU, the fields and the price
  // under it while an earlier Stripe session for the previous version may
  // still be open in another tab. Without this check, paying that stale
  // session would print the edited artwork at the old price, or print a
  // draft the customer never approved. amount_subtotal is compared rather
  // than amount_total because promotion codes are allowed at checkout and
  // discount the total, not the price of the thing being made.
  const sessionMismatch = order.stripe_session_id !== session.id;
  const amountMismatch = Number(session.amount_subtotal) !== Number(order.total_cents);
  const statusMismatch = order.status !== 'pending_payment';
  if (sessionMismatch || amountMismatch || statusMismatch) {
    const reasons = [];
    if (statusMismatch) reasons.push(`order status is "${order.status}", expected "pending_payment"`);
    if (sessionMismatch) reasons.push(`order is waiting on session ${order.stripe_session_id || '(none)'}, paid session is ${session.id}`);
    if (amountMismatch) reasons.push(`order total is ${order.total_cents} cents, session subtotal is ${session.amount_subtotal} cents`);
    const details = {
      stripeSessionId: session.id,
      orderStripeSessionId: order.stripe_session_id || null,
      paymentIntentId: session.payment_intent || null,
      orderStatus: order.status,
      orderTotalCents: order.total_cents,
      sessionAmountSubtotal: session.amount_subtotal ?? null,
      sessionAmountTotal: session.amount_total ?? null,
      reasons,
    };
    console.error(`Stripe webhook: payment mismatch on order ${orderId}: ${reasons.join('; ')}`);
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'payment_mismatch', JSON.stringify(details)]
    );
    // This is real money against an order we refuse to advance. A human has
    // to look, and quickly: either refund it or reconcile it by hand.
    try {
      const emailService = require('../services/emailService');
      const shortId = orderId.substring(0, 8).toUpperCase();
      await emailService.sendAdminAlert(
        `Order ${shortId}: payment received but not applied`,
        `A Stripe payment came in for order ${shortId} but it does not match the order, so the order was NOT moved forward.\n\n` +
        `Order ID: ${orderId}\n` +
        `Stripe session: ${session.id}\n` +
        `Payment intent: ${session.payment_intent || '(none)'}\n` +
        `Customer email: ${session.customer_details?.email || '(none)'}\n\n` +
        `What did not match:\n  ${reasons.join('\n  ')}\n\n` +
        `The customer has been charged. Check the order in the admin dashboard and either refund the payment in Stripe or reconcile the order by hand.`
      );
    } catch (alertErr) {
      console.error(`Failed to send payment mismatch alert for order ${orderId}:`, alertErr.message);
    }
    return;
  }

  console.log(`Stripe webhook: payment confirmed for order ${orderId}`);

  // Save shipping address. On current Stripe API versions the address lives at
  // collected_information.shipping_details — top-level shipping_details was
  // removed. The webhook endpoint (re-created 2026-07-06) delivers the new
  // shape, which silently dropped shipping on the first real order; keep the
  // legacy fields as fallbacks for older payload shapes.
  const shippingDetails = session.collected_information?.shipping_details
    || session.shipping_details
    || session.shipping;
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

  const paymentIntentId = session.payment_intent;
  const email = session.customer_details?.email || '';

  // Everything from here on (tokens, vault, confirmation, review request) is
  // shared with the partner gift checkout, which places an order without a
  // payment. See services/orderAcceptance.js.
  await acceptOrder(db, order, {
    email,
    shippingJson,
    paymentIntentId,
    event: {
      type: 'payment_confirmed',
      data: {
        stripeSessionId: session.id,
        paymentIntentId,
        email,
        amountTotal: session.amount_total,
      },
    },
  });
}

/**
 * Handle a delayed payment that did not clear.
 *
 * The session completed earlier with payment_status 'unpaid' (recorded as a
 * payment_pending event) and the bank has now declined it. The order is left
 * at pending_payment on purpose: Stripe emails the customer a link to try
 * again, and a fresh success arrives as async_payment_succeeded. The event
 * makes the failure visible on the order's timeline; a superseded session's
 * failure is noted but is not this order's news.
 */
async function handleAsyncPaymentFailed(session, db) {
  const orderId = session.metadata?.orderId;
  if (!orderId) return;

  const order = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) {
    console.warn(`Stripe webhook: order ${orderId} not found for async payment failure`);
    return;
  }

  console.log(`Stripe webhook: delayed payment failed for order ${orderId} (session ${session.id})`);
  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [orderId, 'payment_failed', JSON.stringify({
      stripeSessionId: session.id,
      paymentIntentId: session.payment_intent || null,
      paymentStatus: session.payment_status || null,
      superseded: !!(order.stripe_session_id && order.stripe_session_id !== session.id),
    })]
  );
}

/**
 * Handle expired checkout session (customer abandoned).
 *
 * Besides cancelling the order, this sends ONE gentle recovery email inviting
 * the customer to finish their tribute — when an email is available. Email is
 * captured at Stripe (guest checkout), so on expiry it exists only if the
 * customer got far enough to enter it; without one, we no-op gracefully.
 */
async function handleCheckoutExpired(session, db) {
  const orderId = session.metadata?.orderId;
  if (!orderId) return;

  const order = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order || order.status !== 'pending_payment') return;

  // One order row now serves a whole customize→proof→edit→proof→pay session
  // (see findOpenSessionOrder in checkout.js), so an order can outlive several
  // Stripe sessions. An expiry for a SUPERSEDED session must not cancel the
  // order the customer is actively paying for on the current one — Stripe
  // expires abandoned sessions up to 24h later, and checkout.js also expires
  // the previous session itself each time it opens a new one.
  //
  // The row must point at THIS session to be cancelled by it. A NULL pointer
  // means checkout.js has detached it on the way to opening a new session, so
  // the expiry that follows is expected and cancels nothing.
  if (order.stripe_session_id !== session.id) {
    console.log(`Order ${orderId}: ignoring expiry of session ${session.id}, the order no longer points at it`);
    return;
  }

  db.run(
    `UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
    [orderId]
  );

  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [orderId, 'checkout_expired', JSON.stringify({ stripeSessionId: session.id })]
  );

  console.log(`Order ${orderId} cancelled (checkout expired)`);

  // Gentle abandoned-checkout recovery. This person is grieving — one warm,
  // no-pressure invitation to finish, never a nudge.
  //
  // Email comes from the Stripe session (entered at checkout), falling back to
  // any email already stored on the order. No email → nothing to send.
  const email = session.customer_details?.email || order.email || '';
  if (!email) {
    console.log(`Order ${orderId}: no customer email on expiry — recovery email skipped`);
    return;
  }

  // Idempotency: never send this twice for the same order. The status flip to
  // 'cancelled' above already gates re-entry (a duplicate expired event finds
  // the order no longer 'pending_payment' and returns early), but guard on an
  // explicit 'recovery_email_sent' marker too so a manual replay or any future
  // caller of this function can never double-send.
  const alreadySent = db.get(
    `SELECT 1 FROM order_events WHERE order_id = ? AND event_type = 'recovery_email_sent' LIMIT 1`,
    [orderId]
  );
  if (alreadySent) {
    console.log(`Order ${orderId}: recovery email already sent — skipping`);
    return;
  }

  // The webhook must NEVER throw because of email — wrap the send and log
  // failures as an order_event so a delivery problem stays visible without
  // breaking the pipeline.
  try {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
    // The proof step saves the design and links it to this order, so the
    // email reopens THEIR tribute on any device. An order from before saved
    // designs existed (or whose design has expired) falls back to the bare
    // designer, which can still restore from the same browser tab.
    const design = db.get(
      `SELECT token, template_id FROM saved_designs
        WHERE order_id = ? AND expires_at > datetime('now')
        ORDER BY updated_at DESC LIMIT 1`,
      [orderId]
    );
    const resumeUrl = design
      ? `${baseUrl}/customize/${design.template_id}?design=${design.token}`
      : `${baseUrl}/customize/${order.template_id}`;

    // Pet name is best-effort warmth only — a malformed fields_json must never
    // stop the email from going out.
    let petName = '';
    try {
      const fields = order.fields_json ? JSON.parse(order.fields_json) : {};
      petName = fields.petName || '';
    } catch (e) {
      // Non-fatal — send without a name.
    }

    const emailService = require('../services/emailService');
    await emailService.sendAbandonedCheckoutRecovery(email, { petName }, resumeUrl);

    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'recovery_email_sent', JSON.stringify({ email })]
    );
    console.log(`Order ${orderId}: abandoned-checkout recovery email sent to ${email}`);
  } catch (err) {
    console.error(`Failed to send recovery email for order ${orderId}:`, err.message);
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'recovery_email_failed', JSON.stringify({ error: err.message })]
    );
  }
}
module.exports = router;
// Exposed for unit tests only; not part of the route surface.
module.exports.parsePetDate = parsePetDate;
