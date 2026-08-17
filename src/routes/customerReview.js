/**
 * Customer review submission, and the public read side of published reviews.
 *
 * GET  /api/review/:token   Context for the submission page (pet name, whether
 *                           they have already left a review).
 * POST /api/review/:token   Store one review. One per order, ever.
 * GET  /api/reviews         Published reviews plus the honest aggregate.
 *
 * The token is the order's existing proof_token. No new capability token is
 * minted: the customer already holds that link from their proof email, it is
 * already unguessable and already bound to exactly one order, and leaving a
 * review is a strictly smaller power than the proof approval and print-file
 * download it already grants. A review therefore cannot exist without a real,
 * paid order behind it, which is the whole reason these ratings may be
 * published when the 30 legacy quotes in src/data/reviews.json may not.
 */

const express = require('express');
const router = express.Router();
const customerReviews = require('../services/customerReviews');

// A review is invited after the piece ships, but a customer who wants to write
// one earlier should not be turned away. What IS refused is an order that never
// became a real purchase, because those have nothing to review.
const NOT_YET_A_PURCHASE = ['draft', 'pending_payment', 'cancelled'];

const MAX_BODY = 2000;
const MAX_AUTHOR = 60;

/** Same length pre-check the proof and status routes use before touching the DB. */
function findOrderByToken(db, token) {
  if (!token || token.length < 8) return null;
  return db.get('SELECT * FROM orders WHERE proof_token = ?', [token]);
}

/** Pull the pet's name out of the order's saved fields (same keys the engines use). */
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
 * GET /api/review/:token
 * Everything the page needs and nothing it does not: no email, no address, no
 * price. If a review already exists, say so plainly so the page can thank them
 * instead of showing a form that would be refused.
 */
router.get('/review/:token', (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByToken(db, req.params.token);
  if (!order) return res.status(404).json({ error: 'We could not find that order.' });

  if (NOT_YET_A_PURCHASE.includes(order.status)) {
    return res.status(410).json({ error: 'This link is not ready yet.' });
  }

  const existing = db.get(
    'SELECT rating, created_at FROM customer_reviews WHERE order_id = ?',
    [order.id]
  );

  res.json({
    petName: petNameFor(order),
    alreadySubmitted: !!existing,
    submittedRating: existing ? Number(existing.rating) : null,
  });
});

/**
 * POST /api/review/:token
 * Body: { rating, body, authorDisplay, consentToPublish }
 *
 * Nothing here auto-publishes. A stored row is 'pending' until the owner looks
 * at it, so a submission can never put words on the site by itself. The
 * incentivised flag is deliberately NOT accepted from this endpoint: only the
 * shop knows what was comped, so only the shop sets it.
 */
router.post('/review/:token', express.json(), (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByToken(db, req.params.token);
  if (!order) return res.status(404).json({ error: 'We could not find that order.' });

  if (NOT_YET_A_PURCHASE.includes(order.status)) {
    return res.status(410).json({ error: 'This link is not ready yet.' });
  }

  // One review per order. The UNIQUE index is the real guarantee; this is the
  // friendly path, so it answers kindly rather than as an error.
  const existing = db.get('SELECT id FROM customer_reviews WHERE order_id = ?', [order.id]);
  if (existing) {
    return res.status(409).json({
      error: 'You have already left a review for this order. Thank you.',
      alreadySubmitted: true,
    });
  }

  const rating = Number(req.body && req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Please choose a rating from one to five stars.' });
  }

  const body = String((req.body && req.body.body) || '').trim().slice(0, MAX_BODY);
  const authorDisplay = String((req.body && req.body.authorDisplay) || '').trim().slice(0, MAX_AUTHOR);
  const consent = (req.body && req.body.consentToPublish) ? 1 : 0;

  try {
    db.run(
      `INSERT INTO customer_reviews (order_id, rating, body, author_display, consent_to_publish, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [order.id, rating, body || null, authorDisplay || null, consent]
    );
  } catch (err) {
    // The UNIQUE index catching a racing double-submit lands here.
    console.error(`Review submit failed for order ${order.id}:`, err.message);
    const nowExists = db.get('SELECT id FROM customer_reviews WHERE order_id = ?', [order.id]);
    if (nowExists) {
      return res.status(409).json({
        error: 'You have already left a review for this order. Thank you.',
        alreadySubmitted: true,
      });
    }
    return res.status(500).json({ error: 'We could not save that. Please try again.' });
  }

  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [order.id, 'review_submitted', JSON.stringify({
      rating,
      consentToPublish: consent === 1,
      hasBody: !!body,
      submittedAt: new Date().toISOString(),
    })]
  );

  console.log(`Customer review submitted for order ${order.id}: ${rating}/5, consent=${consent === 1}`);
  res.json({ success: true });
});

/**
 * GET /api/reviews
 * Published reviews and the aggregate computed from exactly those rows.
 * With nothing published this returns count 0 and aggregateRating null, and
 * the page is required to render no AggregateRating schema at all.
 */
router.get('/reviews', (req, res) => {
  const db = req.app.locals.db;
  res.set('Cache-Control', 'public, max-age=300');
  res.json(customerReviews.publicPayload(db, req.query.limit));
});

module.exports = router;
