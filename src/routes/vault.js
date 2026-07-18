/**
 * Story Vault routes — the private, tokenized page that keeps a pet's tribute
 * alive after the frame ships, and lets the family opt in to gentle reminders
 * on the days that matter.
 *
 * GET  /api/vault/:token             — the vault's story (pet, photo, poem, memories)
 * POST /api/vault/:token/dates       — save the birthday / gotcha / passing dates + opt-in
 * GET  /api/vault/:token/unsubscribe — one-click opt-out, friendly HTML confirmation
 *
 * Keyed on the vault token, NOT the order's proof/gift token. A vault link
 * grants exactly this: read the story, set the dates, or unsubscribe. It never
 * exposes the order total, the buyer's email, the shipping address, or any
 * power over fulfillment.
 */

const express = require('express');
const router = express.Router();

/** Look up a vault by its public token. Mirrors findOrderByToken's length guard. */
function findVaultByToken(db, token) {
  if (!token || token.length < 8) return null;
  return db.get('SELECT * FROM vaults WHERE token = ?', [token]);
}

/**
 * Resolve the pet's photo URL from the order's stored photos, the same way the
 * renderers do (photos.main, else the first uploaded slot). Returns null when
 * the order has no photo. Uses the full-resolution URL, falling back to the
 * thumbnail.
 */
function resolvePhotoUrl(order) {
  try {
    const photos = order.photos_json ? JSON.parse(order.photos_json) : {};
    const main = photos.main || Object.values(photos)[0];
    if (!main) return null;
    return main.originalUrl || main.thumbnailUrl || null;
  } catch (err) {
    return null;
  }
}

/**
 * Parse a date the family submits from the vault form. Accepts the two shapes
 * the client sends — 'MM-DD' or 'YYYY-MM-DD' — and returns { mmdd, year }.
 * Anything malformed or out of range yields nulls, so a bad field can never
 * overwrite a good stored value with garbage (the route COALESCEs on null).
 */
function parseStructuredDate(str) {
  if (typeof str !== 'string') return { mmdd: null, year: null };
  const s = str.trim();
  let year = null, mm, dd;

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    year = Number(m[1]); mm = Number(m[2]); dd = Number(m[3]);
  } else {
    m = s.match(/^(\d{2})-(\d{2})$/);
    if (!m) return { mmdd: null, year: null };
    mm = Number(m[1]); dd = Number(m[2]);
  }

  // Per-month day cap (Feb allows 29 — the engine handles leap-day rollover),
  // so an impossible "Feb 31" is rejected instead of stored as a date that can
  // never fire.
  const daysInMonth = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (!(mm >= 1 && mm <= 12 && dd >= 1 && dd <= daysInMonth[mm - 1])) return { mmdd: null, year: null };
  const pad = (n) => String(n).padStart(2, '0');
  return { mmdd: `${pad(mm)}-${pad(dd)}`, year };
}

/**
 * GET /api/vault/:token
 * The vault's story, assembled from the joined order: the pet's name, photo,
 * poem, and the memory fields the family wrote — plus the saved dates and the
 * current opt-in / opt-out state so the page renders the "remember" card right.
 */
router.get('/:token', (req, res) => {
  const db = req.app.locals.db;
  const vault = findVaultByToken(db, req.params.token);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const order = vault.order_id
    ? db.get('SELECT * FROM orders WHERE id = ?', [vault.order_id])
    : null;
  const fields = order && order.fields_json ? JSON.parse(order.fields_json) : {};

  res.json({
    petName: vault.pet_name || fields.petName || '',
    photoUrl: order ? resolvePhotoUrl(order) : null,
    poemText: (order && order.poem_text) || '',
    dates: {
      birthday: vault.birthday_mmdd || null,
      gotchaDay: vault.gotcha_mmdd || null,
      passingDay: vault.passing_mmdd || null,
      passingYear: vault.passing_year || null,
    },
    memories: {
      nicknames: fields.petNicknames || '',
      personality: fields.personality || '',
      favoriteMemory: fields.favoriteMemory || '',
      familyName: fields.familyName || '',
    },
    optIn: !!vault.opt_in,
    optOut: !!vault.opt_out,
  });
});

/**
 * POST /api/vault/:token/dates
 * Body: { birthday?, gotchaDay?, passingDay?, optIn }
 * Dates are 'MM-DD' or 'YYYY-MM-DD'; we store the month+day and, for passing,
 * the year when supplied.
 */
router.post('/:token/dates', (req, res) => {
  const db = req.app.locals.db;
  const vault = findVaultByToken(db, req.params.token);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const { birthday, gotchaDay, passingDay, optIn } = req.body || {};
  const b = parseStructuredDate(birthday);
  const g = parseStructuredDate(gotchaDay);
  const p = parseStructuredDate(passingDay);

  // COALESCE so re-saving the form with one field blank doesn't wipe the others:
  // a null parse leaves the stored value untouched. opt_out is deliberately not
  // touched here — only the unsubscribe route clears the sending relationship.
  db.run(
    `UPDATE vaults SET
       birthday_mmdd = COALESCE(?, birthday_mmdd),
       gotcha_mmdd   = COALESCE(?, gotcha_mmdd),
       passing_mmdd  = COALESCE(?, passing_mmdd),
       passing_year  = COALESCE(?, passing_year),
       opt_in = ?
     WHERE id = ?`,
    [b.mmdd, g.mmdd, p.mmdd, p.year, optIn ? 1 : 0, vault.id]
  );

  res.json({ success: true });
});

/**
 * GET /api/vault/:token/unsubscribe
 * One-click opt-out — a plain GET so it works straight from an email client.
 * Always returns a friendly confirmation, and never reveals whether a token
 * was real.
 */
router.get('/:token/unsubscribe', (req, res) => {
  // GET must NOT mutate: corporate mail scanners, SafeLinks and prefetchers
  // auto-GET every URL in an email, which would silently unsubscribe families
  // who asked to be remembered. The GET shows a confirm page; the POST (from
  // its button) performs the actual opt-out.
  const db = req.app.locals.db;
  const vault = findVaultByToken(db, req.params.token);
  const petName = (vault && vault.pet_name) ? vault.pet_name : 'your companion';
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(unsubscribeHtml(petName, { confirmed: false, token: req.params.token }));
});

router.post('/:token/unsubscribe', (req, res) => {
  const db = req.app.locals.db;
  const vault = findVaultByToken(db, req.params.token);
  if (vault) {
    db.run('UPDATE vaults SET opt_out = 1 WHERE id = ?', [vault.id]);
  }
  const petName = (vault && vault.pet_name) ? vault.pet_name : 'your companion';
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(unsubscribeHtml(petName, { confirmed: true }));
});

/** Small brand-styled confirmation page for the unsubscribe link. */
function unsubscribeHtml(petName, opts) {
  const safe = String(petName).replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));
  const confirmed = opts && opts.confirmed;
  const token = (opts && opts.token) ? encodeURIComponent(opts.token) : '';
  const body = confirmed
    ? `<h1>You've been unsubscribed</h1>
    <p>We won't send you any more reminders about ${safe}. Their page will always be here whenever you'd like to visit.</p>`
    : `<h1>Stop the remembrances?</h1>
    <p>If these reminders about ${safe} are more painful than sweet, we understand. Confirm below and we won't send any more.</p>
    <form method="POST" action="/api/vault/${token}/unsubscribe" style="margin-top:24px">
      <button type="submit" style="background:none;border:1px solid #9B9590;border-radius:6px;padding:10px 22px;font-size:0.95rem;color:#2C2C2C;cursor:pointer">Yes, stop the reminders</button>
    </form>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${confirmed ? 'Unsubscribed' : 'Unsubscribe'} | Still Beside Me</title>
  <meta name="robots" content="noindex, nofollow">
  <style>
    body { margin:0; background:#FAF8F5; font-family:'Source Sans Pro',system-ui,-apple-system,sans-serif; color:#2C2C2C; }
    .wrap { max-width:520px; margin:0 auto; padding:64px 24px; text-align:center; }
    h1 { font-family:Georgia,serif; font-weight:400; font-size:1.6rem; margin:0 0 16px; }
    p { line-height:1.6; color:#2C2C2C; }
    .muted { color:#9B9590; font-size:0.9rem; margin-top:32px; }
    a { color:#8B9D83; }
  </style>
</head>
<body>
  <div class="wrap">
    ${body}
    <p class="muted">Still Beside Me &middot; <a href="/">stillbesideme.com</a></p>
  </div>
</body>
</html>`;
}

module.exports = router;
