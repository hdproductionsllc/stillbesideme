/**
 * Stripe Webhook Handler
 * Processes checkout.session.completed and checkout.session.expired events.
 * On successful payment: saves shipping and asks David/Rebecca to review the
 * proof internally.
 *
 * The customer has ALREADY approved their proof, inline, before paying (see
 * src/routes/checkout.js) — so nothing here, and nothing downstream, asks them
 * to approve anything again. The proof they approved is preserved untouched:
 * it is the evidence behind the payment, so this handler will not re-render
 * over it.
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
        await handleCheckoutExpired(session, db);
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

  // Generate proof token (customer-facing) + admin token (fulfillment actions)
  // + gift token (recipient-facing).
  // All three are deliberately separate, in descending order of authority: the
  // customer link must never be able to mark an order shipped, and the gift
  // link must never be able to approve a proof, download the print file, or
  // reveal what the buyer paid. The gift token is printed as a QR code and
  // texted to strangers, so it travels furthest and carries least.
  const proofToken = uuidv4();
  const adminToken = uuidv4();
  const giftToken = uuidv4();

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
       gift_token = ?,
       fulfillment_provider = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
    [paymentIntentId, email, shippingJson, proofToken, adminToken, giftToken, provider, orderId]
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

  // Create the Story Vault for this now-paid order. This lives here, not in
  // checkout.js, for one hard reason: checkout.js inserts a 'pending_payment'
  // order with no customer email (Stripe collects it during checkout) — and a
  // vault with no email can never send. Both the buyer's email and the paid
  // status first exist together at THIS moment, so this is where a real vault
  // belongs. The vault token is a v4 UUID, minted the same way as the proof/
  // admin/gift tokens above. Dates are best-effort prefill from the free-text
  // birthDate/passDate fields: only a real month+day becomes an mmdd (a bare
  // year like "2014" never does), and a passing year is kept when present.
  const vaultToken = uuidv4();
  try {
    // Everything here is best-effort: a malformed fields_json (or any other
    // surprise) must never block the confirmation email / proof steps below.
    const vaultFields = order.fields_json ? JSON.parse(order.fields_json) : {};
    const bd = parsePetDate(vaultFields.birthDate);
    const pd = parsePetDate(vaultFields.passDate);
    db.run(
      `INSERT INTO vaults (order_id, email, pet_name, token, birthday_mmdd, passing_mmdd, passing_year)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orderId, email, vaultFields.petName || '', vaultToken, bd.mmdd, pd.mmdd, pd.year]
    );
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'vault_created', JSON.stringify({ token: vaultToken })]
    );
  } catch (err) {
    // Non-fatal — a missing vault must never block a paid order from proceeding.
    console.error(`Failed to create story vault for order ${orderId}:`, err.message);
  }

  // Step 1: send immediate order-confirmation email — don't make the customer wait for proof
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
  const statusPageUrl = `${baseUrl}/order/${proofToken}`;
  const emailService = require('../services/emailService');

  if (email) {
    try {
      const refreshed = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
      // Gift senders get a link they can text today — see sendOrderConfirmation.
      const orderFields = refreshed.fields_json ? JSON.parse(refreshed.fields_json) : {};
      const giftUrl = orderFields.orderType === 'gift' ? `${baseUrl}/tribute/${giftToken}` : null;
      await emailService.sendOrderConfirmation(email, {
        orderId,
        templateName: refreshed.template_id,
        sku: refreshed.product_sku,
        totalCents: refreshed.total_cents,
      }, statusPageUrl, giftUrl);
      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [orderId, 'order_confirmation_sent', JSON.stringify({ email })]
      );
    } catch (err) {
      console.error(`Failed to send order confirmation for ${orderId}:`, err.message);
      // Non-fatal — proof email comes next anyway
    }
  }

  // Step 2: make sure a proof exists, then ask a human to review it.
  //
  // BRAND RULE: every proof still passes David/Rebecca's review before the
  // tribute goes to the printer. What changed is that the customer is no
  // longer in that loop — they approved their proof inline, before paying, so
  // the review page releases straight to production rather than emailing them
  // anything. Do not add a customer-facing proof email back into this path.
  //
  // When the order carries an inline approval (proof_approved_url), the proof
  // is NOT regenerated. That file at output/proofs/{orderId}.jpg is the exact
  // image the customer accepted before any money moved; re-rendering would
  // overwrite the evidence and, on a paid order, buy us nothing.
  try {
    const inlineApprovedUrl = order.proof_approved_url || null;
    let proofRelativeUrl;

    if (inlineApprovedUrl) {
      proofRelativeUrl = inlineApprovedUrl;
      console.log(`Order ${orderId}: reusing the customer-approved proof (${proofRelativeUrl})`);
    } else {
      // Legacy in-flight order (paid before inline approval shipped): render
      // the proof here as before.
      const proofGenerator = require('../services/proofGenerator');
      const updatedOrder = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
      ({ proofRelativeUrl } = await proofGenerator.generateProof(updatedOrder));

      // Save proof URL to order
      db.run('UPDATE orders SET proof_url = ?, updated_at = datetime(\'now\') WHERE id = ?', [proofRelativeUrl, orderId]);
    }

    const proofImageUrl = `${baseUrl}${proofRelativeUrl}`;
    const reviewUrl = `${baseUrl}/admin/review/${adminToken}`;

    // The review email gets its own try/catch: an email failure is NOT a proof
    // failure, and conflating them (as before 2026-07-19) sends debugging down
    // the wrong path. The proof is already saved above either way.
    try {
      await emailService.sendReviewRequest(
        db.get('SELECT * FROM orders WHERE id = ?', [orderId]),
        { reviewUrl, proofImageUrl }
      );
      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [orderId, 'review_requested', JSON.stringify({ proofUrl: proofRelativeUrl })]
      );
    } catch (emailErr) {
      console.error(`Failed to send review request for order ${orderId}:`, emailErr.message);
      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [orderId, 'review_email_failed', JSON.stringify({ error: emailErr.message, reviewUrl })]
      );
    }

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
  if (order.stripe_session_id && order.stripe_session_id !== session.id) {
    console.log(`Order ${orderId}: ignoring expiry of superseded Stripe session ${session.id}`);
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
    // Honest resume path: there is no persisted per-order resume token, so we
    // link back to the customizer for this order's template (the same URL
    // Stripe uses as its cancel_url). The customizer restores an in-progress
    // design from the browser session when the customer returns, so this is a
    // genuine "pick it back up" — not a saved-cart promise we can't keep.
    const resumeUrl = `${baseUrl}/customize/${order.template_id}`;

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

/**
 * Best-effort parse of a customer's free-text birth/pass date into
 * { mmdd, year }. The birthDate/passDate fields accept anything ("2014",
 * "March 15, 2014", "3/15/2014", "2014-03-15"), so this is deliberately
 * forgiving — but it returns an mmdd ONLY when a real month AND day are present.
 * A bare year yields { mmdd: null, year } so it can seed passing_year without
 * ever fabricating a fake anniversary date. Anything unparseable yields nulls.
 */
function parsePetDate(raw) {
  if (typeof raw !== 'string') return { mmdd: null, year: null };
  const s = raw.trim();
  if (!s) return { mmdd: null, year: null };

  const pad = (n) => String(n).padStart(2, '0');
  // Per-month day cap (Feb allows 29; the date engine rolls leap day forward).
  const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const ok = (mm, dd) => mm >= 1 && mm <= 12 && dd >= 1 && dd <= DAYS_IN_MONTH[mm - 1];

  // Bare year — a real month+day is required for an mmdd.
  if (/^\d{4}$/.test(s)) return { mmdd: null, year: Number(s) };

  // ISO: YYYY-MM-DD
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const mm = Number(m[2]), dd = Number(m[3]);
    return { mmdd: ok(mm, dd) ? `${pad(mm)}-${pad(dd)}` : null, year: Number(m[1]) };
  }

  // Numeric slashes: M/D/YYYY, M/D/YY, or M/D
  m = s.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (m) {
    const mm = Number(m[1]), dd = Number(m[2]);
    const year = m[3] ? Number(m[3].length === 2 ? '20' + m[3] : m[3]) : null;
    return { mmdd: ok(mm, dd) ? `${pad(mm)}-${pad(dd)}` : null, year };
  }

  // Month name + day (+ optional year), in any order ("March 15, 2014",
  // "15 March", "Mar 15 2014").
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const lower = s.toLowerCase();
  const monMatch = lower.match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/);
  const yearMatch = lower.match(/\b(\d{4})\b/);
  // A day number that is not part of the 4-digit year.
  const dayMatch = lower.replace(/\b\d{4}\b/, '').match(/\b(\d{1,2})\b/);
  if (monMatch && dayMatch) {
    const mm = MONTHS[monMatch[1]];
    const dd = Number(dayMatch[1]);
    const year = yearMatch ? Number(yearMatch[1]) : null;
    return { mmdd: ok(mm, dd) ? `${pad(mm)}-${pad(dd)}` : null, year };
  }

  // Fall back to any year we can see (e.g. "March 2014") so passing_year is
  // still captured even without a usable day.
  if (yearMatch) return { mmdd: null, year: Number(yearMatch[1]) };

  return { mmdd: null, year: null };
}

module.exports = router;
// Exposed for unit tests only; not part of the route surface.
module.exports.parsePetDate = parsePetDate;
