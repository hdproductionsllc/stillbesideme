/**
 * Saved-design reminder: the one follow-up to "Email me my design".
 *
 * Once a day (the DESIGN_REMINDERS_ENABLED-gated timer in server.js) this
 * finds designs whose owner asked for the link a couple of days ago and has
 * not ordered since, and sends exactly one gentle note. Then never again:
 * reminder_sent_at is the idempotency record, written only after a send
 * genuinely dispatched (a no-SMTP preview resolves without a messageId and is
 * retried next run rather than burning the only reminder).
 *
 * Skipped, permanently or until things change:
 *   - the family pressed "stop emails about this design" (reminders_off)
 *   - they ordered: the draft linked to this design was paid for, or the same
 *     email address paid for anything after the design was saved
 *   - the save is older than REMIND_WITHIN_DAYS, so switching the engine on
 *     later can never email a backlog of people who asked weeks ago
 *
 * purgeExpired() removes designs past their 90-day expiry. It runs daily
 * whether or not reminders are switched on.
 */

const REMIND_AFTER_DAYS = 2;
const REMIND_WITHIN_DAYS = 14;

// An order in any of these states was never paid for.
const UNPAID_STATUSES = ['draft', 'pending_payment', 'cancelled'];

function hasOrdered(db, design) {
  const unpaid = UNPAID_STATUSES.map(() => '?').join(',');
  if (design.order_id) {
    const linked = db.get(
      `SELECT 1 FROM orders WHERE id = ? AND status NOT IN (${unpaid})`,
      [design.order_id, ...UNPAID_STATUSES]
    );
    if (linked) return true;
  }
  return !!db.get(
    `SELECT 1 FROM orders
      WHERE lower(email) = ? AND status NOT IN (${unpaid})
        AND created_at >= ?
      LIMIT 1`,
    [design.email, ...UNPAID_STATUSES, design.created_at]
  );
}

/**
 * checkAndSend()
 * @returns {Promise<{sent,skipped,failed}>}
 */
async function checkAndSend() {
  const db = await require('../db/database').init();
  const emailService = require('./emailService');
  const { linksFor } = require('../routes/designs');

  const candidates = db.all(
    `SELECT * FROM saved_designs
      WHERE email IS NOT NULL AND email != ''
        AND saved_email_sent_at IS NOT NULL
        AND reminder_sent_at IS NULL
        AND reminders_off = 0
        AND expires_at > datetime('now')
        AND julianday('now') - julianday(saved_email_sent_at) >= ?
        AND julianday('now') - julianday(saved_email_sent_at) <= ?
      ORDER BY saved_email_sent_at ASC`,
    [REMIND_AFTER_DAYS, REMIND_WITHIN_DAYS]
  );

  let sent = 0, skipped = 0, failed = 0;

  for (const design of candidates) {
    if (hasOrdered(db, design)) { skipped++; continue; }

    try {
      const result = await emailService.sendDesignReminder(design.email, {
        petName: design.pet_name,
        ...linksFor(design),
      });
      if (!result || !result.messageId) {
        console.warn(`Design reminder engine: design ${design.id} was a no-SMTP preview, not logged, will retry`);
        failed++;
        continue;
      }
      db.run(`UPDATE saved_designs SET reminder_sent_at = datetime('now') WHERE id = ?`, [design.id]);
      sent++;
      console.log(`Design reminder engine: reminded design ${design.id} at ${design.email}`);
    } catch (err) {
      // One family's send must never stop the run.
      console.error(`Design reminder engine: reminder failed for design ${design.id}:`, err.message);
      failed++;
    }
  }

  console.log(`Design reminder engine: sent=${sent} skipped=${skipped} failed=${failed}`);
  return { sent, skipped, failed };
}

/** Delete designs past their expiry. Returns how many went. */
async function purgeExpired() {
  const db = await require('../db/database').init();
  const before = db.get(`SELECT COUNT(*) AS n FROM saved_designs WHERE expires_at <= datetime('now')`);
  if (before && before.n) {
    db.run(`DELETE FROM saved_designs WHERE expires_at <= datetime('now')`);
    console.log(`Saved designs: removed ${before.n} expired design(s)`);
  }
  return before ? before.n : 0;
}

module.exports = { checkAndSend, purgeExpired, REMIND_AFTER_DAYS, REMIND_WITHIN_DAYS };
