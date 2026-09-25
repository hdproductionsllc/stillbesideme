/**
 * The Stripe webhook must only move an order forward on a payment that is
 * really for that order, really settled, and really ours.
 *
 * This pins four money-path rules against a real (temporary) database, with
 * real signature verification, through the real Express router:
 *
 *   1. A paid session advances the order only when it is the session the order
 *      is waiting on, for the amount the order was priced at, on an order that
 *      is still pending payment. One order row lives through customize, proof,
 *      edit, proof, pay, and an edit rewrites the SKU and price under a Stripe
 *      session that may still be open in another tab. Anything else is logged
 *      as payment_mismatch, alerted to the admin, and left alone.
 *   2. A completed session whose payment has not settled (bank debits and the
 *      like) waits as payment_pending; async_payment_succeeded then completes
 *      it, and async_payment_failed is recorded.
 *   3. The Stripe account is shared with sibling brands, so a session whose
 *      order we do not have is acknowledged and never touches the database,
 *      and an expiry only cancels the order when the order still points at
 *      that exact session.
 *   4. A gift order gets no Story Vault (the paying email is the sender, not
 *      the family) and says so in order_events. A self order still gets one.
 *   5. Deliberate skips answer 200; an unexpected exception answers 500 so
 *      Stripe retries instead of dropping a paid order on the floor.
 *
 *   node tests/stripe-webhook-guards.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Environment BEFORE any module under test loads: they read it at require time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbm-stripe-webhook-test-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.BASE_URL = 'https://example.test';
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
process.env.FULFILLMENT_PROVIDER = 'luma';
delete process.env.SMTP_HOST;
delete process.env.BREVO_API_KEY;
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const express = require('express');
const Stripe = require('stripe');
const database = require('../src/db/database');
const emailService = require('../src/services/emailService');
const stripeWebhooksRouter = require('../src/routes/stripeWebhooks');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── Fixtures ────────────────────────────────────────────────────────────

const PRICE = 15995;

function insertOrder(db, id, { status = 'pending_payment', sessionId = `cs_${id}`, totalCents = PRICE, orderType = 'self' } = {}) {
  db.run(
    `INSERT INTO orders (id, session_id, status, template_id, product_sku, fields_json, photos_json, poem_text,
                         total_cents, stripe_session_id, proof_url, proof_approved_at, proof_approved_url)
     VALUES (?, ?, ?, 'pet-tribute', 'framed-11x14', ?, '{}', 'A poem.', ?, ?, ?, ?, ?)`,
    [
      id, `sess-${id}`, status,
      JSON.stringify({ petName: 'Rex', orderType, birthDate: '3/15/2014', passDate: '2026-01-02' }),
      totalCents, sessionId,
      `/proofs/${id}.jpg?v=1`,
      status === 'draft' ? null : '2026-09-20 10:00:00',
      status === 'draft' ? null : `/proofs/${id}.jpg?v=1`,
    ]
  );
}

function session(orderId, overrides = {}) {
  return {
    id: `cs_${orderId}`,
    object: 'checkout.session',
    payment_status: 'paid',
    payment_intent: `pi_${orderId}`,
    amount_subtotal: PRICE,
    amount_total: PRICE,
    customer_details: { email: 'buyer@example.test' },
    collected_information: {
      shipping_details: {
        name: 'A Buyer',
        address: { line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701', country: 'US' },
      },
    },
    metadata: { orderId },
    ...overrides,
  };
}

function events(db, orderId) {
  return db.all('SELECT event_type FROM order_events WHERE order_id = ? ORDER BY id', [orderId]).map(e => e.event_type);
}

async function post(base, type, sessionObj) {
  const payload = JSON.stringify({ id: `evt_${Date.now()}`, object: 'event', type, data: { object: sessionObj } });
  const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
  const r = await fetch(`${base}/api/stripe-webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': header },
    body: payload,
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

(async () => {
  const db = await database.init();

  // Emails are stubbed: the admin alert is the thing under test, the rest is noise.
  const alerts = [];
  emailService.sendAdminAlert = async (subject, text) => { alerts.push({ subject, text }); return { stubbed: true }; };
  emailService.sendOrderConfirmation = async () => ({ stubbed: true });
  emailService.sendReviewRequest = async () => ({ stubbed: true });
  emailService.sendAbandonedCheckoutRecovery = async () => ({ stubbed: true });

  const app = express();
  app.locals.db = db;
  app.use('/api/stripe-webhooks', express.raw({ type: 'application/json' }));
  app.use('/api/stripe-webhooks', stripeWebhooksRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  console.log('\nStripe webhook: money-path guards\n');

  await check('a bad signature is refused with 400', async () => {
    const r = await fetch(`${base}/api/stripe-webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=nope' },
      body: JSON.stringify({ type: 'checkout.session.completed', data: { object: session('x') } }),
    });
    assert.strictEqual(r.status, 400);
  });

  // ── 1. The happy path still works, and is what every guard is compared to.
  insertOrder(db, 'good');
  await check('a matching paid session advances the order to awaiting_review', async () => {
    const r = await post(base, 'checkout.session.completed', session('good'));
    assert.strictEqual(r.status, 200);
    const o = db.get('SELECT * FROM orders WHERE id = ?', ['good']);
    assert.strictEqual(o.status, 'awaiting_review');
    assert.strictEqual(o.stripe_payment_intent_id, 'pi_good');
    assert.strictEqual(o.email, 'buyer@example.test');
    assert.ok(o.proof_token && o.admin_token && o.gift_token, 'tokens minted');
    assert.ok(events(db, 'good').includes('payment_confirmed'));
    assert.strictEqual(alerts.length, 0, 'no alert on a clean payment');
  });

  await check('a duplicate completed event is a no-op', async () => {
    const before = db.get('SELECT proof_token FROM orders WHERE id = ?', ['good']).proof_token;
    const r = await post(base, 'checkout.session.completed', session('good'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.get('SELECT proof_token FROM orders WHERE id = ?', ['good']).proof_token, before,
      'a replay must not re-mint the token the customer link is keyed on');
    assert.strictEqual(events(db, 'good').filter(e => e === 'payment_confirmed').length, 1);
  });

  // ── 1. Mismatches. Each leaves the order exactly where it was and alerts.
  function assertRefused(id, expectedReasonRe) {
    const o = db.get('SELECT * FROM orders WHERE id = ?', [id]);
    assert.notStrictEqual(o.status, 'awaiting_review', 'order must not advance');
    assert.strictEqual(o.stripe_payment_intent_id, null, 'no payment recorded on the order');
    assert.strictEqual(o.proof_token, null, 'no tokens minted');
    const ev = events(db, id);
    assert.ok(ev.includes('payment_mismatch'), `expected payment_mismatch, got ${ev.join(', ')}`);
    assert.ok(!ev.includes('payment_confirmed'));
    const data = JSON.parse(db.get(
      `SELECT data_json FROM order_events WHERE order_id = ? AND event_type = 'payment_mismatch'`, [id]).data_json);
    assert.ok(data.reasons.some(r => expectedReasonRe.test(r)), `reasons: ${data.reasons.join(' | ')}`);
    const alert = alerts[alerts.length - 1];
    assert.ok(alert && /payment received but not applied/.test(alert.subject), 'admin alerted');
    assert.ok(alert.text.includes(id), 'alert names the order');
  }

  insertOrder(db, 'stale-session');
  await check('a payment on a session the order no longer points at is refused', async () => {
    const n = alerts.length;
    const r = await post(base, 'checkout.session.completed', session('stale-session', { id: 'cs_from_an_earlier_tab' }));
    assert.strictEqual(r.status, 200, 'a deliberate refusal is not a retryable error');
    assertRefused('stale-session', /waiting on session/);
    assert.strictEqual(alerts.length, n + 1, 'exactly one alert');
  });

  insertOrder(db, 'wrong-amount');
  await check('a payment for a different subtotal than the order was priced at is refused', async () => {
    const r = await post(base, 'checkout.session.completed', session('wrong-amount', { amount_subtotal: 3900, amount_total: 3900 }));
    assert.strictEqual(r.status, 200);
    assertRefused('wrong-amount', /subtotal is 3900/);
  });

  insertOrder(db, 'discounted');
  await check('a promotion code lowers the total but not the subtotal, so it is accepted', async () => {
    const r = await post(base, 'checkout.session.completed', session('discounted', { amount_total: PRICE - 2000 }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.get('SELECT status FROM orders WHERE id = ?', ['discounted']).status, 'awaiting_review');
  });

  insertOrder(db, 'edited-after', { status: 'draft', sessionId: null });
  await check('a payment landing on a re-edited draft (approval and session cleared) is refused', async () => {
    const r = await post(base, 'checkout.session.completed', session('edited-after'));
    assert.strictEqual(r.status, 200);
    assertRefused('edited-after', /status is "draft"/);
    assert.strictEqual(db.get('SELECT proof_approved_at FROM orders WHERE id = ?', ['edited-after']).proof_approved_at, null,
      'nothing may manufacture an approval');
  });

  // ── 2. Delayed payment methods.
  insertOrder(db, 'delayed');
  await check('a completed but unpaid session waits as payment_pending', async () => {
    const n = alerts.length;
    const r = await post(base, 'checkout.session.completed', session('delayed', { payment_status: 'unpaid' }));
    assert.strictEqual(r.status, 200);
    const o = db.get('SELECT * FROM orders WHERE id = ?', ['delayed']);
    assert.strictEqual(o.status, 'pending_payment');
    assert.strictEqual(o.proof_token, null);
    assert.deepStrictEqual(events(db, 'delayed'), ['payment_pending']);
    assert.strictEqual(alerts.length, n, 'waiting is not an incident');
  });

  // A 100% promotion code is how a free test order and a friends-and-family
  // code both work. Stripe reports such a session as 'no_payment_required'
  // with no payment_intent, and amount_subtotal still carries the list price.
  // Reading that as "not paid" would strand a real order forever.
  insertOrder(db, 'freebie');
  await check('a $0 order paid with a 100% code is a real order, not a pending one', async () => {
    const n = alerts.length;
    const r = await post(base, 'checkout.session.completed', session('freebie', {
      payment_status: 'no_payment_required',
      payment_intent: null,
      amount_total: 0,
    }));
    assert.strictEqual(r.status, 200);
    const o = db.get('SELECT * FROM orders WHERE id = ?', ['freebie']);
    assert.strictEqual(o.status, 'awaiting_review');
    assert.strictEqual(o.stripe_payment_intent_id, null, 'a free order has no payment intent');
    assert.ok(o.proof_token && o.admin_token, 'tokens minted');
    assert.ok(events(db, 'freebie').includes('payment_confirmed'));
    assert.strictEqual(alerts.length, n, 'a free order is not an incident');
  });

  // Money against an order we told the customer was cancelled is the one case
  // that must never be answered with a quiet 200.
  insertOrder(db, 'was-cancelled', { status: 'cancelled' });
  await check('a payment landing on a cancelled order alerts instead of going quiet', async () => {
    const n = alerts.length;
    const r = await post(base, 'checkout.session.completed', session('was-cancelled'));
    assert.strictEqual(r.status, 200);
    const o = db.get('SELECT * FROM orders WHERE id = ?', ['was-cancelled']);
    assert.strictEqual(o.status, 'cancelled', 'the order is not silently revived');
    assert.ok(events(db, 'was-cancelled').includes('payment_mismatch'));
    assert.strictEqual(alerts.length, n + 1, 'a human is told');
  });

  await check('async_payment_failed is recorded and the order keeps waiting', async () => {
    const r = await post(base, 'checkout.session.async_payment_failed', session('delayed', { payment_status: 'unpaid' }));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.get('SELECT status FROM orders WHERE id = ?', ['delayed']).status, 'pending_payment');
    assert.deepStrictEqual(events(db, 'delayed'), ['payment_pending', 'payment_failed']);
  });

  await check('async_payment_succeeded then completes the order through the same checks', async () => {
    const r = await post(base, 'checkout.session.async_payment_succeeded', session('delayed'));
    assert.strictEqual(r.status, 200);
    const o = db.get('SELECT * FROM orders WHERE id = ?', ['delayed']);
    assert.strictEqual(o.status, 'awaiting_review');
    assert.ok(events(db, 'delayed').includes('payment_confirmed'));
  });

  insertOrder(db, 'delayed-stale');
  await check('async_payment_succeeded on a stale session is refused like any other', async () => {
    await post(base, 'checkout.session.async_payment_succeeded', session('delayed-stale', { id: 'cs_old' }));
    assertRefused('delayed-stale', /waiting on session/);
  });

  // ── 3. Shared Stripe account, and expiry.
  await check('a session for an order we do not have (a sibling brand) is acknowledged, nothing written', async () => {
    const before = db.get('SELECT COUNT(*) AS n FROM order_events').n;
    const r = await post(base, 'checkout.session.completed', session('someone-elses-order'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM order_events').n, before);
  });

  // checkout.js clears the pointer before expiring an old session, because
  // Stripe sends checkout.session.expired straight away. That expiry must not
  // cancel the order (and email an abandoned-checkout note) moments before
  // the customer pays for it on the new session.
  insertOrder(db, 'reopening', { sessionId: null });
  await check('an expiry for a session the order has let go of cancels nothing', async () => {
    const r = await post(base, 'checkout.session.expired', session('reopening'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.get('SELECT status FROM orders WHERE id = ?', ['reopening']).status, 'pending_payment');
    assert.deepStrictEqual(events(db, 'reopening'), []);
  });

  insertOrder(db, 'abandoned');
  await check('an expiry for the session the order is waiting on cancels it', async () => {
    const r = await post(base, 'checkout.session.expired', session('abandoned'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.get('SELECT status FROM orders WHERE id = ?', ['abandoned']).status, 'cancelled');
    assert.ok(events(db, 'abandoned').includes('checkout_expired'));
  });

  // ── 4. Story Vault on gifts.
  await check('a self order gets a Story Vault', async () => {
    const v = db.get('SELECT * FROM vaults WHERE order_id = ?', ['good']);
    assert.ok(v, 'vault row exists');
    assert.strictEqual(v.email, 'buyer@example.test');
    assert.strictEqual(v.pet_name, 'Rex');
    assert.strictEqual(v.birthday_mmdd, '03-15');
    assert.strictEqual(v.passing_year, 2026);
    assert.ok(events(db, 'good').includes('vault_created'));
  });

  insertOrder(db, 'gift', { orderType: 'gift' });
  await check('a gift order gets no Story Vault and says so', async () => {
    const r = await post(base, 'checkout.session.completed', session('gift'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.get('SELECT status FROM orders WHERE id = ?', ['gift']).status, 'awaiting_review', 'the order itself still proceeds');
    assert.strictEqual(db.get('SELECT * FROM vaults WHERE order_id = ?', ['gift']), undefined, 'no vault for the sender');
    const ev = events(db, 'gift');
    assert.ok(ev.includes('vault_skipped_gift'), `expected vault_skipped_gift, got ${ev.join(', ')}`);
    assert.ok(!ev.includes('vault_created'));
  });

  // ── 5. Response codes.
  await check('an unknown order is a deliberate skip: 200, nothing written', async () => {
    const before = db.get('SELECT COUNT(*) AS n FROM order_events').n;
    const r = await post(base, 'checkout.session.completed', session('never-existed'));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM order_events').n, before);
  });

  await check('an unexpected exception answers 500 so Stripe retries', async () => {
    const realDb = app.locals.db;
    app.locals.db = { get() { throw new Error('disk on fire'); }, run() {}, all() { return []; } };
    try {
      const r = await post(base, 'checkout.session.completed', session('good'));
      assert.strictEqual(r.status, 500);
    } finally {
      app.locals.db = realDb;
    }
  });

  server.close();
  database.flush();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
  // Let the loop drain rather than process.exit(): on Windows, exiting while a
  // debounced database write is still on the thread pool aborts the process.
  process.exitCode = failures ? 1 : 0;
})().catch(err => {
  console.error(err);
  process.exit(1);
});
