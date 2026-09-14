/**
 * Real customer tributes published to the homepage gallery.
 *
 * This module is the only way order content reaches the public gallery, and it
 * is deliberately a whitelist rather than a filter. Terms of Service section 5
 * grants us permission to show the finished piece and the poem printed on it,
 * and withholds everything else the customer told us: their surname, their
 * address, their email, and the memories and personality notes they wrote
 * during ordering. That distinction is a promise, so it is enforced here in
 * code instead of being left to whoever writes the next endpoint.
 *
 * Concretely: `shape()` names every field that may be published. A field added
 * to fields_json later is invisible to the gallery until somebody adds it here
 * on purpose. Spreading the order row and deleting the private keys would give
 * the opposite default, which is how the personality notes end up on a homepage
 * eighteen months from now.
 *
 * What may be shown:
 *   pet's first name        printed on the piece
 *   the years               printed on the piece
 *   the poem                printed on the piece
 *   species and layout      used only to write honest alt text
 *
 * What may not, and is therefore never selected:
 *   familyName, giftFrom, personality, favoriteMemory, favoriteThing,
 *   email, shipping_json, and every other column on the order.
 */

/**
 * A piece is publishable only if the shop gave it a slug AND the order is a
 * real purchase. The slug alone is the publish flag, but an order that never
 * became a sale has nothing to show, so the status guard stays as a second
 * lock: a mistyped UPDATE against a draft cannot put a stranger's photo on the
 * homepage.
 */
const NOT_A_PURCHASE = ['draft', 'pending_payment', 'cancelled'];

/** Years exactly as the piece prints them: "2016 – 2026", or a single date. */
function yearsFor(fields) {
  const birth = (fields.birthDate || '').trim();
  const pass = (fields.passDate || '').trim();
  if (birth && pass) return `${birth} – ${pass}`;
  return pass || birth || '';
}

/**
 * Alt text for the framed image. Written from the species and layout rather
 * than kept in a column, so it cannot fall out of step with the piece. No
 * gendered pronoun: we are never told the pet's sex, and guessing it from a
 * name is how alt text ends up wrong about somebody's dog.
 */
function altFor(name, fields) {
  const species = (fields.petType || '').trim().toLowerCase();
  const subject = species ? `${name}, a ${species},` : `${name},`;
  const where = fields.poemFirst || fields.layout === 'stacked' ? 'above' : 'beside';
  return `Framed memorial tribute for ${subject} ${where} the poem written for them`;
}

/** Everything the gallery may publish about one order, and nothing else. */
function shape(row) {
  let fields = {};
  try {
    fields = JSON.parse(row.fields_json || '{}');
  } catch (e) {
    fields = {};
  }
  const name = (fields.petName || '').trim();
  if (!name) return null;

  return {
    slug: row.gallery_slug,
    name,
    years: yearsFor(fields),
    poem: row.poem_text || '',
    alt: altFor(name, fields),
    src: `/gallery/${row.gallery_slug}.jpg`,
  };
}

/**
 * Published pieces, newest first. Returns [] when nothing is published, which
 * is the normal state and must leave the page's demo gallery untouched.
 */
function published(db, limit = 24) {
  const placeholders = NOT_A_PURCHASE.map(() => '?').join(', ');
  const rows = db.all(
    `SELECT gallery_slug, fields_json, poem_text
       FROM orders
      WHERE gallery_slug IS NOT NULL
        AND status NOT IN (${placeholders})
      ORDER BY gallery_published_at DESC, created_at DESC
      LIMIT ?`,
    [...NOT_A_PURCHASE, Math.max(1, Math.min(100, Number(limit) || 24))]
  );
  return rows.map(shape).filter(Boolean);
}

module.exports = { published, shape, altFor, yearsFor };
