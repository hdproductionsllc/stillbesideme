/**
 * Proof-approval follow-up engine.
 *
 * A paid order that reaches `proof_ready` is waiting on ONE thing: the
 * customer opening the proof email and pressing approve. If that email is
 * missed, the order sits there forever — money taken, nothing printed, and a
 * family quietly wondering what happened. Nothing in the app used to notice.
 *
 * Once a day (see the PROOF_REMINDERS_ENABLED-gated timer in server.js) this
 * scans for orders stuck in `proof_ready` and sends at most TWO gentle
 * reminders: one at 3 days, one at 7 days, both counted from the moment the
 * proof email went out (`reviewed_at`, set by the review-gate approve action
 * in src/routes/adminReview.js). Then it stops. Grief is not a funnel — after
 * two notes the piece simply waits.
 *
 * Idempotency has one source of truth: `proof_reminder_sent` rows in
 * order_events. The count of those rows selects the next reminder, so a
 * restart, a replayed run, or two runs in the same day can never double-send.
 * As in the vault date engine, the event row is written ONLY after the send
 * genuinely dispatches (a no-SMTP "preview" resolves without throwing but
 * mails nothing, so logging it would burn a reminder slot for an email the
 * family never got).
 *
 * The approval link is not invented here — it reuses the customer's existing
 * proof_token capability URL, byte for byte the same `${BASE_URL}/proof/:token`
 * that the original proof email used (src/routes/adminReview.js:285).
 */

// Reminder N fires once the order has waited `afterDays` since the proof was
// emailed. Index in this array === how many reminders have already been sent,
// so appending a third entry is the only change a third reminder would need.
const REMINDER_SCHEDULE = [
  { number: 1, afterDays: 3 },
  { number: 2, afterDays: 7 },
];

const MAX_REMINDERS = REMINDER_SCHEDULE.length;

// Floor on the spacing between two reminders, derived from the schedule's own
// gap (7 - 3 = 4 days). Without it, an order already sitting at 8 days the
// first time this engine ever runs would clear BOTH thresholds and get its two
// reminders on consecutive days — which reads as chasing, and this email is
// never allowed to read as chasing.
const MIN_GAP_DAYS = REMINDER_SCHEDULE.length > 1
  ? REMINDER_SCHEDULE[1].afterDays - REMINDER_SCHEDULE[0].afterDays
  : 0;

/** Pull the pet's name out of the order's saved fields (same keys the admin dashboard uses). */
function petNameFor(order) {
  if (!order.fields_json) return '';
  try {
    const fields = JSON.parse(order.fields_json);
    return String(fields.petName || fields.name || '').trim();
  } catch (err) {
    return '';
  }
}

/**
 * checkAndSend()
 *
 * @returns {Promise<{sent,skipped,failed}>} a small run summary.
 */
async function checkAndSend() {
  // Runs outside any request, so it pulls the shared DB singleton directly
  // (init() reuses the already-initialized instance).
  const db = await require('../db/database').init();
  const emailService = require('./emailService');
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';

  // Cast the widest net the schedule could possibly need (the earliest
  // threshold), then decide per-order below. reviewed_at is when the proof
  // email was sent; updated_at is the fallback for any legacy row that
  // reached proof_ready before the review gate existed.
  const candidates = db.all(
    `SELECT *,
            COALESCE(reviewed_at, updated_at) AS proof_sent_at,
            julianday('now') - julianday(COALESCE(reviewed_at, updated_at)) AS days_waiting
       FROM orders
      WHERE status = 'proof_ready'
        AND email IS NOT NULL AND email != ''
        AND proof_token IS NOT NULL AND proof_token != ''
        AND COALESCE(reviewed_at, updated_at) IS NOT NULL
        AND julianday('now') - julianday(COALESCE(reviewed_at, updated_at)) >= ?
      ORDER BY created_at ASC`,
    [REMINDER_SCHEDULE[0].afterDays]
  );

  let sent = 0, skipped = 0, failed = 0;

  for (const order of candidates) {
    // How many reminders has this order already had? That count IS the gate.
    const tally = db.get(
      `SELECT COUNT(*) AS n, MAX(created_at) AS last_at FROM order_events
        WHERE order_id = ? AND event_type = 'proof_reminder_sent'`,
      [order.id]
    );
    const alreadySent = tally ? Number(tally.n) : 0;
    if (alreadySent >= MAX_REMINDERS) { skipped++; continue; }

    const step = REMINDER_SCHEDULE[alreadySent];
    const daysWaiting = Number(order.days_waiting);
    if (!(daysWaiting >= step.afterDays)) { skipped++; continue; }

    // Never stack two reminders back to back (see MIN_GAP_DAYS).
    if (alreadySent > 0 && tally.last_at) {
      const gap = db.get(`SELECT julianday('now') - julianday(?) AS d`, [tally.last_at]);
      if (!(gap && Number(gap.d) >= MIN_GAP_DAYS)) { skipped++; continue; }
    }

    try {
      const result = await emailService.sendProofReminder(
        order.email,
        {
          orderId: order.id,
          petName: petNameFor(order),
          templateName: order.template_id,
          totalCents: order.total_cents,
        },
        // Same two URLs the original proof email was built from — the proof
        // image on disk and the customer's existing proof_token page.
        order.proof_url ? `${baseUrl}${order.proof_url}` : null,
        `${baseUrl}/proof/${order.proof_token}`,
        step.number
      );

      // No SMTP configured → deliver() logs a preview and resolves. That is
      // not a send, so it earns no event row and is retried on the next run.
      if (!result || !result.messageId) {
        console.warn(`Proof reminder engine: reminder #${step.number} for order ${order.id} was a no-SMTP preview — not logged, will retry`);
        failed++;
        continue;
      }

      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [order.id, 'proof_reminder_sent', JSON.stringify({
          reminder: step.number,
          afterDays: step.afterDays,
          daysWaiting: Math.round(daysWaiting * 10) / 10,
          email: order.email,
          sentAt: new Date().toISOString(),
        })]
      );
      sent++;
      console.log(`Proof reminder engine: sent reminder #${step.number} for order ${order.id} to ${order.email} (waiting ${daysWaiting.toFixed(1)}d)`);
    } catch (err) {
      // One family's send must never stop the run — record it and keep going.
      console.error(`Proof reminder engine: reminder #${step.number} failed for order ${order.id}:`, err.message);
      failed++;
      try {
        db.run(
          `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
          [order.id, 'proof_reminder_failed', JSON.stringify({
            reminder: step.number,
            error: err.message,
            failedAt: new Date().toISOString(),
          })]
        );
      } catch (logErr) {
        console.error(`Proof reminder engine: could not record failure for order ${order.id}:`, logErr.message);
      }
    }
  }

  console.log(`Proof reminder engine: sent=${sent} skipped=${skipped} failed=${failed}`);
  return { sent, skipped, failed };
}

module.exports = { checkAndSend, REMINDER_SCHEDULE };
