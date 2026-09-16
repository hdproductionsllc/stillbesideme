/**
 * The status page timeline must report the stage the order is actually at.
 *
 * This exists because of a real support email. Order D3EBBD65 was paid,
 * approved, and sitting at the printer, and its status page drew "Design proof
 * ready for review" as an unlit step in the middle of the list, with the step
 * after it lit. The customer wrote in to say "I don't see any progress on my
 * order."
 *
 * The cause was that a milestone's state was read from the order_events log
 * rather than from order.status. Events are written by whichever route handled
 * the order, and the two approval paths do not write the same rows: the legacy
 * email round-trip logs proof_sent, the inline flow every current order takes
 * never does. So the step was reported unreached on every inline order.
 *
 * The second fixture pins the ordering bug that shipped alongside it. Inline
 * customers approve before they pay, so approval carries the earlier
 * timestamp, and listing it as the later step printed the two dates backwards.
 *
 * Timestamps below are the real ones from that order.
 *
 *   node tests/order-timeline.test.js
 */

const assert = require('assert');
const { buildTimeline } = require('../src/routes/orderStatus');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

const byKey = (timeline) => Object.fromEntries(timeline.map(m => [m.key, m]));

// ---------------------------------------------------------------------------
// Order D3EBBD65 as it stood when the customer wrote in: approved inline before
// payment, released by hand, submitted to Luma, waiting on the printer.
// ---------------------------------------------------------------------------
const inlineOrder = {
  id: 'd3ebbd65-9fed-40ef-9984-dbe11592a6a9',
  status: 'in_production',
  created_at: '2026-09-12 03:54:32',
  proof_approved_at: '2026-09-12 04:12:18',
};

const inlineEvents = [
  { event_type: 'order_created', created_at: '2026-09-12 03:54:32' },
  { event_type: 'proof_approved_inline', created_at: '2026-09-12 04:12:18' },
  { event_type: 'payment_confirmed', created_at: '2026-09-12 04:17:43' },
  { event_type: 'luma_submitted', created_at: '2026-09-12 04:27:04' },
];

console.log('\nInline order at the printer (the reported bug):');

check('no step is left unlit behind a lit one', () => {
  const timeline = buildTimeline(inlineOrder, inlineEvents);
  const firstPending = timeline.findIndex(m => m.state === 'pending');
  if (firstPending === -1) return;
  const litAfter = timeline.slice(firstPending).filter(m => m.state === 'done');
  assert.deepStrictEqual(
    litAfter.map(m => m.key), [],
    `steps marked done after the first pending step: ${litAfter.map(m => m.key).join(', ')}`
  );
});

check('every step before the current one is done', () => {
  const timeline = buildTimeline(inlineOrder, inlineEvents);
  const current = timeline.findIndex(m => m.state === 'current');
  assert.notStrictEqual(current, -1, 'no step marked current');
  for (const m of timeline.slice(0, current)) {
    assert.strictEqual(m.state, 'done', `step "${m.key}" before the current one is "${m.state}"`);
  }
});

check('the printing step is the current one', () => {
  const timeline = buildTimeline(inlineOrder, inlineEvents);
  assert.strictEqual(byKey(timeline).production.state, 'current');
});

check('the customer approval step is dated and done', () => {
  const step = byKey(buildTimeline(inlineOrder, inlineEvents)).approved;
  assert.strictEqual(step.state, 'done');
  assert.strictEqual(step.at, '2026-09-12 04:12:18');
});

check('dates run forwards down the page', () => {
  const stamps = buildTimeline(inlineOrder, inlineEvents)
    .map(m => m.at).filter(Boolean);
  const sorted = [...stamps].sort();
  assert.deepStrictEqual(stamps, sorted, `dates are out of order: ${stamps.join(' | ')}`);
});

check('the printing step is dated when it reached the printer, not when approved', () => {
  const step = byKey(buildTimeline(inlineOrder, inlineEvents)).production;
  assert.strictEqual(step.at, '2026-09-12 04:27:04');
});

check('it does not claim ink is on paper while the printer may still be queuing', () => {
  const step = byKey(buildTimeline(inlineOrder, inlineEvents)).production;
  assert.ok(
    !/being printed/i.test(step.detail),
    `overstates production: "${step.detail}"`
  );
});

// ---------------------------------------------------------------------------
// Same order one stage earlier: paid, waiting on the human review gate.
// ---------------------------------------------------------------------------
console.log('\nInline order awaiting the review gate:');

const awaitingReview = { ...inlineOrder, status: 'awaiting_review' };
const awaitingEvents = inlineEvents.slice(0, 3);

check('the review step is current, and named for review rather than printing', () => {
  const step = byKey(buildTimeline(awaitingReview, awaitingEvents)).production;
  assert.strictEqual(step.state, 'current');
  assert.ok(/final check/i.test(step.label), `label claims printing too early: "${step.label}"`);
});

check('payment and approval are both already done', () => {
  const steps = byKey(buildTimeline(awaitingReview, awaitingEvents));
  assert.strictEqual(steps.paid.state, 'done');
  assert.strictEqual(steps.approved.state, 'done');
});

// ---------------------------------------------------------------------------
// Shipped, and the legacy email round-trip, which must both still hold.
// ---------------------------------------------------------------------------
console.log('\nShipped and legacy orders:');

check('a shipped order has every step done and none current', () => {
  const shipped = { ...inlineOrder, status: 'shipped' };
  const timeline = buildTimeline(shipped, [
    ...inlineEvents,
    { event_type: 'luma_shipped', created_at: '2026-09-17 10:02:00' },
  ]);
  assert.deepStrictEqual(timeline.filter(m => m.state !== 'done').map(m => m.key), []);
});

check('a legacy order still shows its emailed proof step', () => {
  const legacy = {
    id: '4e4644c5-fad7-44dd-b732-cc846e2551ff',
    status: 'in_production',
    created_at: '2026-08-12 17:30:00',
    proof_approved_at: '2026-08-12 21:00:00',
  };
  const timeline = buildTimeline(legacy, [
    { event_type: 'order_created', created_at: '2026-08-12 17:30:00' },
    { event_type: 'payment_confirmed', created_at: '2026-08-12 17:35:00' },
    { event_type: 'proof_sent', created_at: '2026-08-12 19:00:00' },
    { event_type: 'proof_approved', created_at: '2026-08-12 21:00:00' },
    { event_type: 'luma_submitted', created_at: '2026-08-12 21:05:00' },
  ]);
  const steps = byKey(timeline);
  assert.ok(steps.proof, 'legacy timeline lost its proof step');
  assert.strictEqual(steps.proof.state, 'done');
  assert.strictEqual(steps.approved.state, 'current');
});

check('an unpaid order marks payment as the current step', () => {
  const unpaid = { ...inlineOrder, status: 'pending_payment' };
  const steps = byKey(buildTimeline(unpaid, [
    { event_type: 'order_created', created_at: '2026-09-12 03:54:32' },
  ]));
  assert.strictEqual(steps.paid.state, 'current');
  assert.strictEqual(steps.production.state, 'pending');
});

check('a cancelled order cancels everything after it was placed', () => {
  const cancelled = { ...inlineOrder, status: 'cancelled' };
  const timeline = buildTimeline(cancelled, inlineEvents);
  assert.strictEqual(timeline[0].state, 'done');
  assert.deepStrictEqual(
    timeline.slice(1).map(m => m.state),
    timeline.slice(1).map(() => 'cancelled')
  );
});

console.log(
  failures === 0
    ? '\nAll timeline checks passed.\n'
    : `\n${failures} timeline check(s) failed.\n`
);
process.exit(failures === 0 ? 0 : 1);
