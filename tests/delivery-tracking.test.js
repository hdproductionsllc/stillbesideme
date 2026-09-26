/**
 * Carrier-confirmed delivery, and the review invite that waits for it.
 *
 * The review invite used to go out ten days after SHIPPING, which asked
 * families whose parcel was late, lost, or on its way back to us. It now waits
 * for the carrier to say "delivered". This proves, against a real (temporary)
 * database and a stand-in for the USPS API:
 *
 *   1. USPS answers are read correctly: delivered, returned (which USPS words
 *      as "Delivered, To Original Sender"), and still moving.
 *   2. The delivery check asks only about USPS parcels shipped in the last 30
 *      days that are not already settled, records the carrier's own delivery
 *      time, alerts once on a return, reuses its token, and stops on a rate
 *      limit.
 *   3. With no USPS credentials it does nothing at all.
 *   4. End to end: a parcel delivered five days ago gets its one invite; a
 *      returned one and an unconfirmed one never do.
 *
 *   node tests/delivery-tracking.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Environment BEFORE any module under test loads: they read it at require time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbm-delivery-test-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.UPLOADS_DIR = path.join(TMP, 'uploads');
process.env.BASE_URL = 'https://example.test';
delete process.env.SMTP_HOST;
delete process.env.USPS_CONSUMER_KEY;
delete process.env.USPS_CONSUMER_SECRET;
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const database = require('../src/db/database');
const emailService = require('../src/services/emailService');
const usps = require('../src/services/uspsTracking');
const deliveryEngine = require('../src/services/deliveryEngine');
const reviewInviteEngine = require('../src/services/reviewInviteEngine');

/** An ISO timestamp N days ago, in the offset-less local form USPS uses. */
function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 19);
}

// Shapes follow the USPS Tracking 3.2 spec (tracking-v3r2 OpenAPI 3.2.8): per
// parcel, a headline status plus events newest first, each event carrying a
// local eventTimestamp and a UTC GMTTimestamp.
const USPS = {
  delivered: (when) => ({
    trackingNumber: 'x',
    statusCategory: 'Delivered',
    status: 'Delivered, In/At Mailbox',
    trackingEvents: [
      { eventType: 'Delivered, In/At Mailbox', eventTimestamp: when, GMTTimestamp: `${when}.000Z`, eventCity: 'AUSTIN', eventState: 'TX' },
      { eventType: 'Out for Delivery', eventTimestamp: when },
    ],
  }),
  returned: {
    statusCategory: 'Delivered',
    status: 'Delivered, To Original Sender',
    trackingEvents: [{ eventType: 'Delivered, To Original Sender', eventTimestamp: daysAgoIso(1) }],
  },
  inTransit: {
    statusCategory: 'In Transit',
    status: 'In Transit to Next Facility',
    trackingEvents: [{ eventType: 'In Transit to Next Facility', eventTimestamp: daysAgoIso(1) }],
  },
};

(async () => {
  // ── 1. Reading USPS answers ──────────────────────────────────────────
  const when = daysAgoIso(5);
  let c = usps.classify(USPS.delivered(when));
  assert.strictEqual(c.state, 'delivered');
  assert.strictEqual(c.deliveredAt, `${when}.000Z`, 'the carrier\'s own delivery time in UTC, not ours');
  const localOnly = USPS.delivered(when);
  delete localOnly.trackingEvents[0].GMTTimestamp;
  assert.strictEqual(usps.classify(localOnly).deliveredAt, when, 'falls back to the local timestamp');
  assert.strictEqual(usps.classify(USPS.returned).state, 'returned', 'return to sender is not a delivery');
  assert.strictEqual(usps.classify(USPS.inTransit).state, 'in_transit');
  assert.strictEqual(usps.classify({ statusCategory: 'Alert', status: 'Refused' }).state, 'returned');
  assert.strictEqual(usps.classify({}).state, 'in_transit', 'an empty answer is never a delivery');
  assert.ok(usps.handlesCarrier('USPS') && !usps.handlesCarrier('UPS') && !usps.handlesCarrier(''));

  // ── Fixture orders ───────────────────────────────────────────────────
  const db = await database.init();
  function order(id, { email = `${id}@example.test`, shippedDaysAgo, luma, partner }) {
    db.run(
      `INSERT INTO orders (id, template_id, status, email, proof_token, fields_json, tracking_number, tracking_carrier)
       VALUES (?, 'pet', 'shipped', ?, ?, ?, ?, ?)`,
      [id, email, `tok-${id}-0123456789`, JSON.stringify({ petName: 'Rex' }),
        partner ? partner.number : null, partner ? partner.carrier : null]
    );
    if (luma) {
      db.run(
        `INSERT INTO luma_orders (order_id, status, tracking_number, tracking_carrier) VALUES (?, 'shipped', ?, ?)`,
        [id, luma.number, luma.carrier]
      );
    }
    db.run(
      `INSERT INTO order_events (order_id, event_type, created_at) VALUES (?, ?, datetime('now', ?))`,
      [id, partner ? 'partner_shipped' : 'luma_shipped', `-${shippedDaysAgo} days`]
    );
  }
  order('arrived', { shippedDaysAgo: 9, luma: { number: 'USPS-ARRIVED', carrier: 'USPS' } });
  order('sentBack', { shippedDaysAgo: 8, partner: { number: 'USPS-RETURNED', carrier: 'USPS' } });
  order('moving', { shippedDaysAgo: 2, luma: { number: 'USPS-MOVING', carrier: 'USPS' } });
  order('onUps', { shippedDaysAgo: 3, luma: { number: '1Z999', carrier: 'UPS' } });
  order('stale', { shippedDaysAgo: 40, luma: { number: 'USPS-STALE', carrier: 'USPS' } });

  // A stand-in for apis.usps.com that records every call. Tracking 3.2 takes a
  // list of parcels in one POST and answers per parcel, with 207 when some
  // parcels are errors.
  const calls = [];      // every URL hit
  const asked = [];      // the tracking numbers in each tracking request
  let rateLimited = false;
  const realFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push(url);
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (url === 'https://apis.usps.com/oauth2/v3/token') {
      const sent = JSON.parse(opts.body);
      assert.strictEqual(sent.grant_type, 'client_credentials');
      assert.strictEqual(sent.client_id, 'test-key');
      return json(200, { access_token: 'tok', expires_in: 28800 });
    }
    assert.strictEqual(url, 'https://apis.usps.com/tracking/v3r2/tracking');
    assert.strictEqual(opts.method, 'POST');
    assert.strictEqual(opts.headers.Authorization, 'Bearer tok');
    if (rateLimited) return json(429, { error: { message: 'Too many requests' } });
    const numbers = JSON.parse(opts.body).map(p => p.trackingNumber);
    asked.push(numbers);
    const answer = numbers.map((n) => {
      if (n === 'USPS-ARRIVED') return { ...USPS.delivered(when), trackingNumber: n, statusCode: '200' };
      if (n === 'USPS-RETURNED') return { ...USPS.returned, trackingNumber: n, statusCode: '200' };
      if (n === 'USPS-MOVING') return { ...USPS.inTransit, trackingNumber: n, statusCode: '200' };
      if (n === 'USPS-UNSCANNED') return { trackingNumber: n, statusCode: '404', error: { message: 'not found' } };
      throw new Error(`unexpected lookup ${n}`);
    });
    const mixed = answer.some(a => a.statusCode !== '200');
    return json(mixed ? 207 : 200, answer);
  };

  const alerts = [];
  emailService.sendAdminAlert = async (subject, body) => { alerts.push({ subject, body }); };

  // ── 3. No credentials: nothing happens ───────────────────────────────
  let run = await deliveryEngine.checkDeliveries();
  assert.deepStrictEqual(run, { delivered: 0, returned: 0, pending: 0, unsupported: 0, failed: 0 });
  assert.strictEqual(calls.length, 0, 'no USPS call without credentials');

  // ── 2. The delivery check ────────────────────────────────────────────
  process.env.USPS_CONSUMER_KEY = 'test-key';
  process.env.USPS_CONSUMER_SECRET = 'test-secret';

  order('unscanned', { shippedDaysAgo: 1, luma: { number: 'USPS-UNSCANNED', carrier: 'USPS' } });
  run = await deliveryEngine.checkDeliveries();
  assert.deepStrictEqual(run, { delivered: 1, returned: 1, pending: 2, unsupported: 1, failed: 0 },
    'a label USPS has not scanned yet (per-parcel 404 inside a 207) is simply still on its way');
  assert.strictEqual(calls.filter(u => u.endsWith('/token')).length, 1, 'one token for the whole run');
  assert.strictEqual(asked.length, 1, 'every parcel in ONE tracking request');
  assert.deepStrictEqual(asked[0], ['USPS-ARRIVED', 'USPS-RETURNED', 'USPS-MOVING', 'USPS-UNSCANNED'], 'oldest shipment first');
  assert.ok(!asked[0].includes('USPS-STALE'), 'a parcel shipped 40 days ago is no longer asked about');

  const delivered = db.get(`SELECT created_at, data_json FROM order_events WHERE order_id = 'arrived' AND event_type = 'carrier_delivered'`);
  assert.ok(delivered, 'delivery recorded');
  assert.strictEqual(delivered.created_at, when.replace('T', ' '), 'recorded at the carrier\'s delivery time');
  assert.ok(db.get(`SELECT 1 FROM order_events WHERE order_id = 'sentBack' AND event_type = 'carrier_returned'`), 'partner-shipped parcels are read from the orders row');
  assert.strictEqual(alerts.length, 1, 'one alert for the returned parcel');
  assert.ok(alerts[0].body.includes('USPS-RETURNED') && alerts[0].body.includes('sentBack@example.test'));

  // Next day: settled parcels are left alone, only the unsettled ones are asked about.
  calls.length = 0;
  asked.length = 0;
  run = await deliveryEngine.checkDeliveries();
  assert.deepStrictEqual(run, { delivered: 0, returned: 0, pending: 2, unsupported: 1, failed: 0 });
  assert.deepStrictEqual(asked, [['USPS-MOVING', 'USPS-UNSCANNED']]);
  assert.ok(!calls.some(u => u.endsWith('/token')), 'the token is reused across runs');
  assert.strictEqual(alerts.length, 1, 'never a second alert for the same return');

  // A rate limit costs one request and records nothing.
  rateLimited = true;
  calls.length = 0;
  run = await deliveryEngine.checkDeliveries();
  assert.deepStrictEqual(run, { delivered: 0, returned: 0, pending: 0, unsupported: 1, failed: 2 });
  assert.strictEqual(calls.length, 1, 'one refused request, no retries');
  rateLimited = false;

  // ── 4. End to end with the review invite ─────────────────────────────
  const invites = [];
  emailService.sendReviewInvite = async (to) => { invites.push(to); return { messageId: `m-${invites.length}` }; };
  run = await reviewInviteEngine.checkAndSend();
  assert.deepStrictEqual(invites, ['arrived@example.test'], 'only the confirmed, 5-day-old delivery is asked');
  assert.deepStrictEqual(run, { sent: 1, skipped: 0, failed: 0 });

  global.fetch = realFetch;
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('delivery-tracking: all assertions passed');
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
