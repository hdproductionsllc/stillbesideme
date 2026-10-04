/**
 * Partners: the practices that give our tribute to families as a gift.
 *
 * A partner link (/gift/<slug>) does two separate things, and they are kept
 * separate on purpose:
 *
 *   attribution — every order this browser goes on to make, gift or paid,
 *                 records the partner. That never switches off: a family who
 *                 came from a practice came from it, even if the link is
 *                 paused or the month's gifts are used up.
 *   the gift    — the free keepsake. That is what the cap, the pause and the
 *                 one-per-email rule protect, because the link is printed on
 *                 cards that can travel anywhere.
 *
 * A framed order placed later from a gift keepsake (the "Have it framed"
 * button reopens their saved design) keeps the partner too, through the
 * design's link to the gift order. That is the number the shop actually cares
 * about: which practices lead to framed pieces.
 */

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KINDS = ['clinic', 'home-euthanasia', 'crematorium', 'other'];

// Orders that never became real: an unfinished design, an abandoned checkout.
// None of them used up a gift or counts as something a partner sent us.
const NOT_PLACED = ['draft', 'pending_payment', 'cancelled'];

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

function findBySlug(db, slug) {
  if (!slug || !SLUG_RE.test(slug)) return null;
  return db.get('SELECT * FROM partners WHERE slug = ?', [slug]) || null;
}

function findById(db, id) {
  if (!id) return null;
  return db.get('SELECT * FROM partners WHERE id = ?', [id]) || null;
}

/**
 * Add a partner. Returns { partner } or { error }.
 * The slug is derived from the name unless one is given; it is the public
 * part of their link, so it is validated rather than trusted.
 */
function createPartner(db, input) {
  const name = String((input && input.name) || '').trim().slice(0, 120);
  if (!name) return { error: 'A partner needs a name.' };

  const slug = input.slug ? String(input.slug).trim().toLowerCase() : slugify(name);
  if (!SLUG_RE.test(slug)) {
    return { error: 'The link name can only use lowercase letters, numbers and single dashes.' };
  }
  if (findBySlug(db, slug)) return { error: `The link /gift/${slug} is already taken.` };

  const kind = KINDS.includes(input.kind) ? input.kind : 'clinic';
  const contactEmail = input.contactEmail ? String(input.contactEmail).trim().slice(0, 200) : null;
  const cap = Number.parseInt(input.monthlyCap, 10);
  const monthlyCap = Number.isFinite(cap) && cap > 0 && cap <= 1000 ? cap : 30;
  const notes = input.notes ? String(input.notes).trim().slice(0, 2000) : null;

  db.run(
    `INSERT INTO partners (slug, name, kind, contact_email, monthly_cap, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [slug, name, kind, contactEmail, monthlyCap, notes]
  );
  return { partner: findBySlug(db, slug) };
}

/** Pause or resume a link, or change its cap. Returns the updated row. */
function updatePartner(db, id, changes) {
  const partner = findById(db, id);
  if (!partner) return null;
  const active = typeof changes.active === 'boolean' ? (changes.active ? 1 : 0) : partner.active;
  const cap = Number.parseInt(changes.monthlyCap, 10);
  const monthlyCap = Number.isFinite(cap) && cap > 0 && cap <= 1000 ? cap : partner.monthly_cap;
  db.run(
    `UPDATE partners SET active = ?, monthly_cap = ?, updated_at = datetime('now') WHERE id = ?`,
    [active, monthlyCap, id]
  );
  return findById(db, id);
}

/** Free keepsakes this partner's link has made this calendar month. */
function giftsThisMonth(db, partnerId, giftSku) {
  const row = db.get(
    `SELECT COUNT(*) AS n FROM orders
      WHERE partner_id = ? AND product_sku = ?
        AND status NOT IN (${NOT_PLACED.map(() => '?').join(',')})
        AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')`,
    [partnerId, giftSku, ...NOT_PLACED]
  );
  return row ? Number(row.n) : 0;
}

/**
 * Can this link give a keepsake right now?
 * @returns {{ available: boolean, reason?: 'inactive'|'cap' }}
 */
function giftAvailability(db, partner, giftSku) {
  if (!partner || !partner.active) return { available: false, reason: 'inactive' };
  if (giftsThisMonth(db, partner.id, giftSku) >= partner.monthly_cap) {
    return { available: false, reason: 'cap' };
  }
  return { available: true };
}

/** Has this email already received a keepsake through this partner? */
function emailAlreadyGifted(db, partnerId, giftSku, email) {
  const row = db.get(
    `SELECT 1 FROM orders
      WHERE partner_id = ? AND product_sku = ? AND lower(email) = lower(?)
        AND status NOT IN (${NOT_PLACED.map(() => '?').join(',')})
      LIMIT 1`,
    [partnerId, giftSku, email, ...NOT_PLACED]
  );
  return !!row;
}

/**
 * Which partner, if any, sent the person making this request.
 *
 * The session remembers the link they arrived through. A saved design carries
 * it across devices and across time: the gift email's "Have it framed" button
 * opens their design, which is linked to the gift order, which knows the
 * partner. The session wins when both are present.
 */
function partnerIdForRequest(db, req) {
  const fromSession = req.session && Number(req.session.partnerId);
  if (fromSession && findById(db, fromSession)) return fromSession;

  const token = req.body && req.body.designToken;
  if (token && typeof token === 'string') {
    const row = db.get(
      `SELECT o.partner_id AS partner_id FROM saved_designs d
         JOIN orders o ON o.id = d.order_id
        WHERE d.token = ? AND o.partner_id IS NOT NULL
        LIMIT 1`,
      [token]
    );
    if (row && row.partner_id) return Number(row.partner_id);
  }
  return null;
}

/**
 * Every partner with what it has sent us: keepsakes given, orders placed that
 * were not the free keepsake, and what those orders were worth.
 */
function listWithStats(db, giftSku) {
  const partners = db.all('SELECT * FROM partners ORDER BY created_at DESC, id DESC');
  const placeholders = NOT_PLACED.map(() => '?').join(',');
  return partners.map((p) => {
    const gifts = db.get(
      `SELECT COUNT(*) AS n FROM orders
        WHERE partner_id = ? AND product_sku = ? AND status NOT IN (${placeholders})`,
      [p.id, giftSku, ...NOT_PLACED]
    );
    const paid = db.get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total_cents), 0) AS cents FROM orders
        WHERE partner_id = ? AND product_sku != ? AND status NOT IN (${placeholders})`,
      [p.id, giftSku, ...NOT_PLACED]
    );
    return {
      ...p,
      giftsGiven: gifts ? Number(gifts.n) : 0,
      giftsThisMonth: giftsThisMonth(db, p.id, giftSku),
      paidOrders: paid ? Number(paid.n) : 0,
      paidCents: paid ? Number(paid.cents) : 0,
    };
  });
}

module.exports = {
  KINDS,
  slugify,
  findBySlug,
  findById,
  createPartner,
  updatePartner,
  giftsThisMonth,
  giftAvailability,
  emailAlreadyGifted,
  partnerIdForRequest,
  listWithStats,
};
