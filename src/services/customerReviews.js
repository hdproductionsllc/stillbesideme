/**
 * Customer reviews: the only source of star ratings this site is allowed to use.
 *
 * There are two bodies of rated customer feedback and this module is the single
 * place they are added together.
 *
 * 1. The legacy 30, in src/data/reviews.json. Ratings WERE collected from these
 *    customers (28 fives, 2 fours, 148 points across 30 reviews). What was not
 *    kept is which score belonged to which person, so the aggregate is real but
 *    no individual legacy quote can carry a reviewRating. Held as points and a
 *    count rather than a mean, precisely so new ratings can be folded in.
 *
 * 2. New rows in the customer_reviews table: ratings a named buyer chose
 *    themselves against an order they paid for, once published.
 *
 * The combined mean is (legacy points + new points) / (legacy count + new
 * count). Deriving it here is the point of the whole file: a mean typed into a
 * page drifts the moment a review is published or hidden, and a computed one
 * cannot. Nothing anywhere else may hardcode this number.
 *
 * The aggregate is emitted only while real rating data exists. That is true
 * today because of the legacy 30, but the guard stays: strip legacyRatings out
 * and publish nothing, and the correct output becomes silence again rather than
 * a zero or a placeholder.
 */

const catalogue = require('../data/reviews.json');

/**
 * Legacy points and count, read from data rather than typed. Defensive against
 * the field being removed or malformed: a missing block means the legacy
 * contribution is simply zero, never NaN leaking into a published rating.
 */
const LEGACY = (() => {
  const l = catalogue && catalogue.legacyRatings;
  const count = Number(l && l.count) || 0;
  const total = Number(l && l.total) || 0;
  return (count > 0 && total > 0) ? { count, total } : { count: 0, total: 0 };
})();

/** A row is publishable only if the customer consented AND the shop published it. */
const PUBLISHED_WHERE = `status = 'published' AND consent_to_publish = 1`;

/**
 * Combined count and mean: the legacy 30 plus every published new review.
 *
 * @returns {{count, mean, ratingValue, legacyCount, newCount}}
 *   count 0 and mean null only if there is genuinely no rating data at all.
 *   Callers MUST treat count 0 as "emit no AggregateRating".
 */
function summary(db) {
  const row = db.get(
    `SELECT COUNT(*) AS n, COALESCE(SUM(rating), 0) AS pts
       FROM customer_reviews WHERE ${PUBLISHED_WHERE}`
  );
  const newCount = row ? Number(row.n) : 0;
  const newPoints = row ? Number(row.pts) : 0;

  const count = LEGACY.count + newCount;
  const points = LEGACY.total + newPoints;
  if (!count) {
    return { count: 0, mean: null, ratingValue: null, legacyCount: 0, newCount: 0 };
  }

  // One decimal is what Google shows, and it is the most precision an average
  // of this many ratings can honestly carry. Truncation is deliberate over any
  // form of flattering rounding: 4.93 shows as 4.9, and never as 5.0.
  const mean = Math.round((points / count) * 10) / 10;
  return {
    count,
    mean,
    ratingValue: mean.toFixed(1),
    legacyCount: LEGACY.count,
    newCount,
  };
}

/**
 * The published reviews themselves, newest first, shaped for rendering.
 * `incentivised` rides along on every row because the disclosure label is not
 * optional: FTC's 2024 Rule on Consumer Reviews requires it to be visible
 * wherever the review is shown, so no caller is allowed to receive the review
 * text without also receiving the flag.
 */
function published(db, limit = 50) {
  return db.all(
    `SELECT id, rating, body, author_display, incentivised, published_at
       FROM customer_reviews
      WHERE ${PUBLISHED_WHERE}
      ORDER BY published_at DESC, id DESC
      LIMIT ?`,
    [Math.max(1, Math.min(200, Number(limit) || 50))]
  ).map(r => ({
    id: r.id,
    rating: Number(r.rating),
    body: r.body || '',
    author: r.author_display || 'A customer',
    incentivised: Number(r.incentivised) === 1,
    publishedAt: r.published_at || null,
  }));
}

/**
 * The AggregateRating node, or null when there is nothing honest to say.
 * Returning null is the normal, expected state until real ratings arrive.
 */
function aggregateRatingJsonLd(db) {
  const { count, ratingValue } = summary(db);
  if (!count) return null;
  return {
    '@type': 'AggregateRating',
    ratingValue,
    bestRating: '5',
    worstRating: '1',
    reviewCount: String(count),
  };
}

/** Everything a page needs in one read. */
function publicPayload(db, limit = 50) {
  const s = summary(db);
  return {
    count: s.count,
    mean: s.mean,
    ratingValue: s.ratingValue,
    legacyCount: s.legacyCount,
    newCount: s.newCount,
    // Only the NEW reviews are returned for rendering. The legacy 30 are
    // already written into the pages as quotes, and re-serving them here would
    // duplicate them on screen while telling us nothing the count does not.
    reviews: s.newCount ? published(db, limit) : [],
    aggregateRating: aggregateRatingJsonLd(db),
  };
}

module.exports = { summary, published, aggregateRatingJsonLd, publicPayload, PUBLISHED_WHERE };
