/**
 * Story Vault date engine.
 *
 * Once a day (see the DATE_ENGINE_ENABLED-gated timer in server.js) this scans
 * every opted-in vault for one whose birthday / gotcha day / anniversary of
 * passing falls on today's calendar date, and sends the matching email — at
 * most once per occasion per calendar year.
 *
 * The at-most-once guarantee has two layers: this engine checks vault_email_log
 * before sending (the fast path), and the log's UNIQUE(vault_id, occasion, year)
 * constraint is the hard backstop. We write the log row ONLY after the email
 * send resolves without throwing, so a send failure is retried on the next run
 * rather than silently swallowed.
 *
 * Leap day: a date stored as '02-29' would otherwise never match in a common
 * year, quietly skipping every family whose day fell on Feb 29. So in a common
 * year we roll it forward one day — on Feb 28 we also match '02-29'. In a leap
 * year Feb 29 exists and matches itself, so no rollover is needed.
 */

/** Zero-pad a month/day number to two digits. */
function pad(n) {
  return String(n).padStart(2, '0');
}

/** Standard Gregorian leap-year test. */
function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// occasion -> which vault date column it matches and which email to send.
// `column` is a fixed internal allowlist, never user input, so it is safe to
// interpolate into the SQL below.
const OCCASIONS = [
  { occasion: 'birthday',    column: 'birthday_mmdd', send: 'sendBirthdayEmail' },
  { occasion: 'gotcha',      column: 'gotcha_mmdd',   send: 'sendGotchaEmail' },
  { occasion: 'anniversary', column: 'passing_mmdd',  send: 'sendAnniversaryEmail' },
];

/**
 * checkAndSend(todayStr?)
 *
 * @param {string} [todayStr] — 'MM-DD' override, for tests. Defaults to today.
 * @returns {Promise<{date,year,sent,skipped,failed}>} a small run summary.
 */
async function checkAndSend(todayStr) {
  // The engine runs outside any request, so it pulls the shared DB singleton
  // directly (init() reuses the already-initialized instance).
  const db = await require('../db/database').init();
  const vaultEmails = require('./vaultEmails');

  // "Today" is computed in the business timezone, not the server's — the prod
  // box runs in a different region (UTC/SEA on Railway), and a birthday email
  // arriving on the wrong calendar day defeats the whole point of the feature.
  const tz = process.env.DATE_ENGINE_TZ || 'America/Chicago';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((p) => p.type === type).value;
  const mmdd = todayStr || `${get('month')}-${get('day')}`;
  const year = Number(get('year'));
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';

  // Dates we treat as "today". Normally just today; in a common year Feb 28 also
  // stands in for the Feb 29 that never comes. These come from the calendar, not
  // from user input, so they are safe to bind (and to build placeholders for).
  const targets = [mmdd];
  if (mmdd === '02-28' && !isLeapYear(year)) targets.push('02-29');
  const placeholders = targets.map(() => '?').join(', ');

  let sent = 0, skipped = 0, failed = 0;

  for (const { occasion, column, send } of OCCASIONS) {
    const vaults = db.all(
      `SELECT * FROM vaults
        WHERE opt_in = 1 AND opt_out = 0
          AND email IS NOT NULL AND email != ''
          AND ${column} IN (${placeholders})`,
      targets
    );

    for (const vault of vaults) {
      // Already sent this occasion this year? Nothing to do.
      const already = db.get(
        `SELECT 1 FROM vault_email_log WHERE vault_id = ? AND occasion = ? AND year = ?`,
        [vault.id, occasion, year]
      );
      if (already) { skipped++; continue; }

      try {
        const result = await vaultEmails[send](vault, baseUrl);
        // A missing-SMTP "preview" resolves without throwing but sends nothing.
        // Logging it would permanently mark the occasion sent-for-the-year and
        // the family would never get the real email once SMTP returns — so only
        // a genuine dispatch (messageId) earns a log row; previews retry later.
        if (!result || !result.messageId) {
          console.warn(`Vault date engine: ${occasion} email for vault ${vault.id} was a no-SMTP preview — not logged, will retry`);
          failed++;
          continue;
        }
        // Log ONLY after a real send — a failure stays un-logged and is
        // retried tomorrow.
        db.run(
          `INSERT INTO vault_email_log (vault_id, occasion, year) VALUES (?, ?, ?)`,
          [vault.id, occasion, year]
        );
        sent++;
        console.log(`Vault date engine: sent ${occasion} email to vault ${vault.id} (${vault.pet_name || 'unnamed'}) <${vault.email}>`);
      } catch (err) {
        // One family's send must never stop the run — log it and keep going.
        console.error(`Vault date engine: ${occasion} email failed for vault ${vault.id}:`, err.message);
        failed++;
      }
    }
  }

  console.log(`Vault date engine (${mmdd}): sent=${sent} skipped=${skipped} failed=${failed}`);
  return { date: mmdd, year, sent, skipped, failed };
}

module.exports = { checkAndSend };
