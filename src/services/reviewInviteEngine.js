/**
 * Customer review invitations.
 *
 * Once a day (see the REVIEW_INVITES_ENABLED-gated timer in server.js) this
 * looks for orders that shipped a while ago and asks the buyer, exactly once,
 * how the piece turned out. Ten days after the shipping event, not one: the
 * frame has to arrive, be unwrapped, and be hung somewhere before anyone can
 * honestly say whether it looks like their animal. Asking on day two would be
 * asking about a courier, not about the work.
 *
 * Exactly one ask, ever. There is no reminder schedule here and there must not
 * be one. A family that does not reply has said something, and chasing them for
 * a star rating about a dead pet would be indefensible.
 *
 * Idempotency has one source of truth: `review_invite_sent` rows in
 * order_events. As in followupEngine and dateEngine, the row is written ONLY
 * after the send genuinely dispatches, because a no-SMTP "preview" resolves
 * without throwing and logging it would burn the single ask on an email nobody
 * received.
 *
 * The link is not a new capability: it reuses the customer's existing
 * proof_token, the same token behind ${BASE_URL}/proof/:token, now also serving
 * ${BASE_URL}/review/:token.
 */

// Days after the shipping event before the ask goes out.
const INVITE_AFTER_DAYS = 10;

// Upper bound on how far back this will reach. Without it, the first run after
// this engine is switched on would email every customer in the history of the
// business at once, asking people whose piece arrived last year whether it
// arrived safely. Only orders inside this window are ever invited; anything
// older is treated as water under the bridge and skipped permanently.
const INVITE_WITHIN_DAYS = 60;

// Whichever provider fulfilled it, the shipping event is the clock start.
const SHIPPED_EVENTS = ['luma_shipped', 'partner_shipped', 'whcc_shipped'];

/** Pull the pet's name out of the order's saved fields (same keys the other engines use). */
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

  const placeholders = SHIPPED_EVENTS.map(() => '?').join(',');

  // MIN(created_at) because a provider can re-deliver its shipping webhook; the
  // first one is the true ship date. The window is applied in SQL at both ends.
  const candidates = db.all(
    `SELECT o.*,
            s.shipped_at,
            julianday('now') - julianday(s.shipped_at) AS days_since_shipped
       FROM orders o
       JOIN (SELECT order_id, MIN(created_at) AS shipped_at
               FROM order_events
              WHERE event_type IN (${placeholders})
              GROUP BY order_id) s
         ON s.order_id = o.id
      WHERE o.email IS NOT NULL AND o.email != ''
        AND o.proof_token IS NOT NULL AND o.proof_token != ''
        AND julianday('now') - julianday(s.shipped_at) >= ?
        AND julianday('now') - julianday(s.shipped_at) <= ?
      ORDER BY s.shipped_at ASC`,
    [...SHIPPED_EVENTS, INVITE_AFTER_DAYS, INVITE_WITHIN_DAYS]
  );

  let sent = 0, skipped = 0, failed = 0;

  for (const order of candidates) {
    // Already asked? That is the gate, and it is permanent.
    const already = db.get(
      `SELECT 1 FROM order_events WHERE order_id = ? AND event_type = 'review_invite_sent' LIMIT 1`,
      [order.id]
    );
    if (already) { skipped++; continue; }

    // Someone who has already written to us must never be asked to write again.
    const reviewed = db.get(
      'SELECT 1 FROM customer_reviews WHERE order_id = ? LIMIT 1',
      [order.id]
    );
    if (reviewed) { skipped++; continue; }

    const daysSince = Number(order.days_since_shipped);

    try {
      const result = await emailService.sendReviewInvite(
        order.email,
        { orderId: order.id, petName: petNameFor(order) },
        `${baseUrl}/review/${order.proof_token}`
      );

      // No SMTP configured means deliver() logged a preview and resolved. That
      // is not a send, so it earns no event row and is retried on the next run.
      if (!result || !result.messageId) {
        console.warn(`Review invite engine: invite for order ${order.id} was a no-SMTP preview, not logged, will retry`);
        failed++;
        continue;
      }

      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [order.id, 'review_invite_sent', JSON.stringify({
          afterDays: INVITE_AFTER_DAYS,
          daysSinceShipped: Math.round(daysSince * 10) / 10,
          email: order.email,
          sentAt: new Date().toISOString(),
        })]
      );
      sent++;
      console.log(`Review invite engine: asked order ${order.id} at ${order.email} (shipped ${daysSince.toFixed(1)}d ago)`);
    } catch (err) {
      // One family's send must never stop the run. Record it and keep going.
      console.error(`Review invite engine: invite failed for order ${order.id}:`, err.message);
      failed++;
      try {
        db.run(
          `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
          [order.id, 'review_invite_failed', JSON.stringify({
            error: err.message,
            failedAt: new Date().toISOString(),
          })]
        );
      } catch (logErr) {
        console.error(`Review invite engine: could not record failure for order ${order.id}:`, logErr.message);
      }
    }
  }

  console.log(`Review invite engine: sent=${sent} skipped=${skipped} failed=${failed}`);
  return { sent, skipped, failed };
}

module.exports = { checkAndSend, INVITE_AFTER_DAYS, INVITE_WITHIN_DAYS };
