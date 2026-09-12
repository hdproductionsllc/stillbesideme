#!/usr/bin/env node
/**
 * Acquisition and funnel report — read-only.
 *
 * Answers the questions that can be answered from our own database, and says
 * plainly which ones cannot. Written because the strategic question in front of
 * the business ("is the product invisible, or is acquisition simply expensive?")
 * turns entirely on numbers nobody had put on one page.
 *
 * READ-ONLY BY CONSTRUCTION. It opens the database, runs SELECTs, and prints.
 * It never writes, so it is safe to run against production while orders are in
 * flight. (sql.js loads the file into memory and only persists on an explicit
 * save, which this script never triggers.)
 *
 *   node scripts/acquisition-report.js
 *   node scripts/acquisition-report.js --months 6
 *   node scripts/acquisition-report.js --json     # machine-readable
 *
 * THE LIMIT THAT MATTERS: traffic source is not recorded anywhere. No utm_*,
 * no referrer, no gclid, no fbclid, on any table. So "what did these customers
 * cost to acquire" and "how many came from cold paid vs organic" are NOT
 * derivable here at any level of effort — they have to be reconstructed from
 * GA4, Google Ads, Meta and Stripe by hand, and those four will not reconcile
 * exactly. The checklist at the end of the output says what to pull from where.
 */

const path = require('path');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const monthsIdx = args.indexOf('--months');
const MONTHS = monthsIdx !== -1 ? Math.max(1, Number(args[monthsIdx + 1]) || 12) : 12;

// Statuses that mean money actually changed hands. 'pending_payment' is a
// checkout that was started and never completed, which is why it is counted
// separately below rather than folded into either side.
const PAID = ['submitted', 'awaiting_review', 'proof_ready', 'proof_approved',
              'change_requested', 'in_production', 'shipped', 'delivered'];

const money = (c) => '$' + ((Number(c) || 0) / 100).toFixed(2);
const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + '%' : '—');

function bar(n, max, width = 24) {
  if (!max) return '';
  return '█'.repeat(Math.max(0, Math.round((n / max) * width)));
}

(async () => {
  const db = await require(path.join(__dirname, '..', 'src', 'db', 'database')).init();
  const out = {};
  const q = (sql, p = []) => db.all(sql, p);
  const one = (sql, p = []) => db.get(sql, p);

  const paidList = PAID.map(() => '?').join(',');

  // ── Headline ────────────────────────────────────────────────────────
  const totals = one(
    `SELECT COUNT(*) AS orders,
            COALESCE(SUM(total_cents), 0) AS revenue
       FROM orders WHERE status IN (${paidList})`, PAID);
  out.paidOrders = Number(totals.orders);
  out.revenueCents = Number(totals.revenue);
  out.aovCents = out.paidOrders ? Math.round(out.revenueCents / out.paidOrders) : 0;

  const firstLast = one(
    `SELECT MIN(created_at) AS first, MAX(created_at) AS last
       FROM orders WHERE status IN (${paidList})`, PAID);
  out.firstOrder = firstLast.first;
  out.lastOrder = firstLast.last;

  // ── Funnel ──────────────────────────────────────────────────────────
  // Every order ever created, by where it stopped. 'draft' is someone who
  // opened the builder and never reached Stripe; 'pending_payment' reached
  // Stripe and did not pay. Those two are the acquisition leak.
  out.byStatus = q(`SELECT status, COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS cents
                      FROM orders GROUP BY status ORDER BY n DESC`)
    .map(r => ({ status: r.status, n: Number(r.n), cents: Number(r.cents) }));

  const allOrders = out.byStatus.reduce((a, r) => a + r.n, 0);
  const drafts = out.byStatus.filter(r => r.status === 'draft').reduce((a, r) => a + r.n, 0);
  const abandoned = out.byStatus.filter(r => r.status === 'pending_payment').reduce((a, r) => a + r.n, 0);
  out.allOrderRows = allOrders;
  out.drafts = drafts;
  out.abandonedCheckouts = abandoned;
  out.reachedCheckout = abandoned + out.paidOrders;
  out.draftToCheckout = pct(out.reachedCheckout, allOrders);
  out.checkoutToPaid = pct(out.paidOrders, out.reachedCheckout);

  // ── Builder starts, from the event log ──────────────────────────────
  // order_created is written when a draft first persists, so it is the closest
  // thing we have to "someone genuinely started building one".
  const starts = one(`SELECT COUNT(DISTINCT order_id) AS n FROM order_events WHERE event_type = 'order_created'`);
  out.builderStarts = Number(starts ? starts.n : 0);

  // ── Monthly trend ───────────────────────────────────────────────────
  out.monthly = q(
    `SELECT substr(created_at,1,7) AS month, COUNT(*) AS n, COALESCE(SUM(total_cents),0) AS cents
       FROM orders WHERE status IN (${paidList})
      GROUP BY month ORDER BY month DESC LIMIT ?`, [...PAID, MONTHS])
    .map(r => ({ month: r.month, n: Number(r.n), cents: Number(r.cents) })).reverse();

  // ── Mix: gift vs self, template, sku ────────────────────────────────
  const paidOrders = q(`SELECT fields_json, product_sku, template_id, total_cents
                          FROM orders WHERE status IN (${paidList})`, PAID);
  let gift = 0, self = 0, unknown = 0;
  const skus = {};
  const templates = {};
  for (const o of paidOrders) {
    let f = {};
    try { f = o.fields_json ? JSON.parse(o.fields_json) : {}; } catch (e) { /* ignore */ }
    if (f.orderType === 'gift') gift++;
    else if (f.orderType === 'self') self++;
    else unknown++;
    skus[o.product_sku || '(none)'] = (skus[o.product_sku || '(none)'] || 0) + 1;
    templates[o.template_id || '(none)'] = (templates[o.template_id || '(none)'] || 0) + 1;
  }
  out.giftVsSelf = { gift, self, unrecorded: unknown };
  out.skuMix = skus;
  out.templateMix = templates;

  // ── Proof behaviour ─────────────────────────────────────────────────
  // How often the proof lands right first time. A high change-request rate is
  // a product signal; a high never-approved rate is a trust or timing signal.
  const ev = (t) => Number((one(`SELECT COUNT(DISTINCT order_id) AS n FROM order_events WHERE event_type = ?`, [t]) || {}).n || 0);
  out.proofsSent = ev('proof_sent');
  out.proofsApproved = ev('proof_approved') + ev('proof_approved_inline');
  out.changeRequests = ev('change_requested');
  out.recoveryEmailsSent = ev('recovery_email_sent');
  out.shipped = ev('luma_shipped') + ev('partner_shipped');

  // ── Reviews ─────────────────────────────────────────────────────────
  try {
    const cr = one(`SELECT COUNT(*) AS n, COALESCE(AVG(rating),0) AS avg
                      FROM customer_reviews WHERE status = 'published' AND consent_to_publish = 1`);
    out.publishedReviews = Number(cr.n);
    out.publishedMean = Number(cr.avg).toFixed(2);
    out.reviewInvites = ev('review_invite_sent');
    out.reviewsSubmitted = ev('review_submitted');
  } catch (e) { out.publishedReviews = null; }

  // ── Email list ──────────────────────────────────────────────────────
  try {
    const subs = one(`SELECT COUNT(*) AS n FROM subscribers`);
    out.subscribers = Number(subs.n);
  } catch (e) { out.subscribers = null; }

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    process.exit(0);
  }

  // ── Render ──────────────────────────────────────────────────────────
  const H = (s) => `\n${s}\n${'─'.repeat(s.length)}`;
  console.log(H('HEADLINE'));
  console.log(`  Paid orders            ${out.paidOrders}`);
  console.log(`  Revenue                ${money(out.revenueCents)}`);
  console.log(`  AOV                    ${money(out.aovCents)}`);
  console.log(`  First paid order       ${out.firstOrder || '—'}`);
  console.log(`  Most recent            ${out.lastOrder || '—'}`);

  console.log(H('FUNNEL (all order rows ever created)'));
  console.log(`  Builder starts         ${out.builderStarts}`);
  console.log(`  Order rows             ${out.allOrderRows}`);
  console.log(`    still draft          ${out.drafts}  (opened the builder, never reached Stripe)`);
  console.log(`    reached checkout     ${out.reachedCheckout}  (${out.draftToCheckout} of all rows)`);
  console.log(`      abandoned          ${out.abandonedCheckouts}`);
  console.log(`      paid               ${out.paidOrders}  (${out.checkoutToPaid} of those who reached checkout)`);
  console.log(`  Recovery emails sent   ${out.recoveryEmailsSent}`);

  console.log(H('BY STATUS'));
  const maxS = Math.max(...out.byStatus.map(r => r.n), 1);
  for (const r of out.byStatus) {
    console.log(`  ${String(r.status).padEnd(18)} ${String(r.n).padStart(4)}  ${bar(r.n, maxS)}`);
  }

  console.log(H(`MONTHLY (last ${MONTHS})`));
  if (!out.monthly.length) console.log('  (no paid orders yet)');
  const maxM = Math.max(...out.monthly.map(r => r.n), 1);
  for (const r of out.monthly) {
    console.log(`  ${r.month}  ${String(r.n).padStart(3)} orders  ${money(r.cents).padStart(10)}  ${bar(r.n, maxM, 18)}`);
  }

  console.log(H('MIX'));
  console.log(`  Gift                   ${out.giftVsSelf.gift}`);
  console.log(`  For themselves         ${out.giftVsSelf.self}`);
  console.log(`  Order type unrecorded  ${out.giftVsSelf.unrecorded}`);
  console.log('  SKUs:');
  for (const [k, v] of Object.entries(out.skuMix).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(k).padEnd(20)} ${v}`);
  }

  console.log(H('PROOF BEHAVIOUR'));
  console.log(`  Proofs sent            ${out.proofsSent}`);
  console.log(`  Approved               ${out.proofsApproved}  (${pct(out.proofsApproved, out.proofsSent)} of proofs sent)`);
  console.log(`  Change requests        ${out.changeRequests}  (${pct(out.changeRequests, out.proofsSent)} of proofs sent)`);
  console.log(`                         A high rate here means the writing misses on the first pass.`);
  console.log(`  Shipped                ${out.shipped}`);

  console.log(H('AUDIENCE'));
  console.log(`  Email subscribers      ${out.subscribers === null ? 'n/a' : out.subscribers}`);
  if (out.publishedReviews !== null) {
    console.log(`  Review invites sent    ${out.reviewInvites}`);
    console.log(`  Reviews submitted      ${out.reviewsSubmitted}  (${pct(out.reviewsSubmitted, out.reviewInvites)} of invites)`);
    console.log(`  Published              ${out.publishedReviews}${out.publishedReviews ? `, mean ${out.publishedMean}` : ''}`);
  }

  console.log(H('WHAT THIS REPORT CANNOT TELL YOU'));
  console.log(`  Traffic source is recorded NOWHERE — no utm_*, no referrer, no gclid,
  no fbclid, on any table. So CAC, channel mix, and "where did these
  customers come from" are not derivable here at any level of effort.

  Pull these by hand, then divide:

    Google Ads    →  spend, impressions, clicks, conversions, by campaign
    Meta Ads      →  spend, impressions, clicks, purchases, by campaign
    GA4           →  sessions, users, source/medium, product-page views
    Stripe        →  gross, refunds, fees (the true net, which the
                     total_cents above does NOT deduct)

    CAC          = (Google spend + Meta spend) / paid orders in the same window
    Contribution = AOV − print COGS − shipping − Stripe fees − CAC

  Two cautions. Attribution across Ads, Meta and GA4 will not reconcile —
  each claims credit differently, so compare each channel's spend against
  TOTAL orders in the window rather than trying to make the three agree.
  And the order count here is orders, not customers: a repeat buyer is two
  rows, so per-customer economics will look slightly worse than per-order.`);

  console.log(H('THE FIX WORTH MAKING TODAY'));
  console.log(`  Start recording source on every order. Capturing utm_source /
  utm_medium / utm_campaign / gclid / fbclid at first touch and storing them
  on the order is a small change, and it is the difference between answering
  this question properly in ninety days and reconstructing it by hand again.
  Every day it stays uncaptured is a day of attribution permanently lost.`);

  console.log('');
  process.exit(0);
})().catch((err) => {
  console.error('Report failed:', err.message);
  process.exit(1);
});
