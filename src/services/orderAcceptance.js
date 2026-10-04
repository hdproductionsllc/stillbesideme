/**
 * An order is placed: what happens next, whoever paid for it.
 *
 * Until partner gifts, the only way an order was placed was Stripe telling us
 * it had been paid, so all of this lived inside the payment webhook. A gift
 * keepsake is placed with no payment at all, and must go through exactly the
 * same steps: the tokens, the record, the confirmation to the family, and the
 * human review before anything is delivered. So the steps live here, and the
 * webhook and the gift checkout are two doors into them.
 *
 * Each door does its own checking BEFORE calling acceptOrder: the webhook
 * proves the money matches the order, the gift checkout proves the partner
 * link may give one. By the time an order reaches here it is real.
 */

const { v4: uuidv4 } = require('uuid');
const products = require('./products');

/**
 * @param {object} db
 * @param {object} order — the order row, still in pending_payment or draft
 * @param {object} details
 * @param {string} details.email
 * @param {string|null} [details.shippingJson]
 * @param {string|null} [details.paymentIntentId]
 * @param {{ type: string, data: object }} details.event — what placed it
 */
async function acceptOrder(db, order, details) {
  const orderId = order.id;
  const email = details.email || '';
  const shippingJson = details.shippingJson || null;
  const paymentIntentId = details.paymentIntentId || null;
  const isGift = products.isGiftOrder(order);

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
    console.warn(`Order ${orderId}: FULFILLMENT_PROVIDER not set — defaulting to 'luma'`);
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

  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [orderId, details.event.type, JSON.stringify(details.event.data || {})]
  );

  // A payment is a fact Stripe will not tell us twice: once we answer 200 the
  // event is spent. Put it on disk now rather than trusting the debounce to
  // outlive a redeploy that lands in the next 100ms.
  require('../db/database').flush();

  // Create the Story Vault for this now-placed order. This lives here, not in
  // checkout.js, for one hard reason: checkout.js inserts a 'pending_payment'
  // order with no customer email (Stripe collects it during checkout) — and a
  // vault with no email can never send. Both the buyer's email and the placed
  // status first exist together at THIS moment, so this is where a real vault
  // belongs. The vault token is a v4 UUID, minted the same way as the proof/
  // admin/gift tokens above. Dates are best-effort prefill from the free-text
  // birthDate/passDate fields: only a real month+day becomes an mmdd (a bare
  // year like "2014" never does), and a passing year is kept when present.
  //
  // NOT for gift orders. The vault is keyed to the email that paid, and on a
  // gift that is the sender, not the family who lost the animal. Left
  // unguarded it invited the *buyer* to be reminded, every year, of the death
  // of someone else's pet — and asked them on the confirmation page for the
  // birthday, gotcha day and date of passing, which are precisely the three
  // facts a gift buyer does not have. Skipping creation is the whole fix:
  // every reader downstream already treats a missing vault as normal
  // (checkout.js returns vaultToken null and the confirmation card renders
  // nothing; the insert card for a gift points at /tribute/{gift_token} and
  // never used the vault anyway; the date engine has nothing to select).
  // Remembering the days is still the right offer — it just has to reach the
  // recipient, through the tribute page, and not the person who paid.
  //
  // A partner keepsake is the family's own, so it gets a vault like any order.
  const vaultToken = uuidv4();
  try {
    // Everything here is best-effort: a malformed fields_json (or any other
    // surprise) must never block the confirmation email / proof steps below.
    const vaultFields = order.fields_json ? JSON.parse(order.fields_json) : {};
    if (vaultFields.orderType === 'gift') {
      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
        [orderId, 'vault_skipped_gift', JSON.stringify({
          reason: 'gift order - the paying email is the sender, not the family',
        })]
      );
    } else {
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
    }
  } catch (err) {
    // Non-fatal — a missing vault must never block a placed order from proceeding.
    console.error(`Failed to create story vault for order ${orderId}:`, err.message);
  }

  // Step 1: send immediate order-confirmation email — don't make the customer wait for proof
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
  const statusPageUrl = `${baseUrl}/order/${proofToken}`;
  const emailService = require('./emailService');
  const partner = order.partner_id
    ? require('./partners').findById(db, order.partner_id)
    : null;

  if (email) {
    try {
      const refreshed = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
      const orderFields = refreshed.fields_json ? JSON.parse(refreshed.fields_json) : {};
      if (isGift) {
        await emailService.sendGiftKeepsakeReceived(email, {
          orderId,
          petName: orderFields.petName || '',
          partnerName: partner ? partner.name : '',
        }, statusPageUrl);
      } else {
        // Gift senders get a link they can text today — see sendOrderConfirmation.
        const giftUrl = orderFields.orderType === 'gift' ? `${baseUrl}/tribute/${giftToken}` : null;
        await emailService.sendOrderConfirmation(email, {
          orderId,
          templateName: refreshed.template_id,
          sku: refreshed.product_sku,
          totalCents: refreshed.total_cents,
        }, statusPageUrl, giftUrl);
      }
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
      const proofGenerator = require('./proofGenerator');
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
        { reviewUrl, proofImageUrl, partnerName: partner ? partner.name : null, isGift }
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

    console.log(`Order ${orderId}: proof ready — awaiting human review at /admin/review/${adminToken}`);
  } catch (err) {
    console.error(`Failed to generate proof for order ${orderId}:`, err.message);
    // Order is saved and placed — proof can be generated/sent manually
    db.run(
      `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
      [orderId, 'proof_generation_failed', JSON.stringify({ error: err.message })]
    );

    // Alert the admin — this order is placed and silently stalled otherwise
    try {
      const shortId = orderId.substring(0, 8).toUpperCase();
      await emailService.sendAdminAlert(
        `Order ${shortId} stalled: proof generation failed`,
        `Order ${shortId} is placed but its proof could not be generated.\n\n` +
        `Order ID: ${orderId}\n` +
        `Step: proof generation (order placed)\n` +
        `Error: ${err.message}\n\n` +
        `Review page: ${baseUrl}/admin/review/${adminToken}`
      );
    } catch (alertErr) {
      console.error(`Failed to send admin alert for order ${orderId}:`, alertErr.message);
    }
  }

  return { proofToken, adminToken, giftToken };
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

module.exports = { acceptOrder, parsePetDate };
