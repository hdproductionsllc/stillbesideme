/**
 * Customer review submission, and the public read side of published reviews.
 *
 * GET  /api/review/:token        Context for the submission page (pet name,
 *                                whether they have already left a review).
 * POST /api/review/:token        Store one review, with an optional photo of
 *                                the piece hung. One per order, ever.
 * GET  /api/reviews              Published reviews plus the honest aggregate.
 * GET  /api/reviews/:id/photo    The photo, only while published with consent.
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
const multer = require('multer');
const router = express.Router();
const customerReviews = require('../services/customerReviews');
const reviewPhotos = require('../services/reviewPhotos');

// A review is invited after the piece ships, but a customer who wants to write
// one earlier should not be turned away. What IS refused is an order that never
// became a real purchase, because those have nothing to review.
const NOT_YET_A_PURCHASE = ['draft', 'pending_payment', 'cancelled'];

const MAX_BODY = 2000;
const MAX_AUTHOR = 60;

// The photo rides in as multipart. Memory storage because it is normalised and
// written by reviewPhotos immediately; 15MB covers a modern phone HEIC. The
// page sends multipart whether or not a photo was chosen, but JSON is still
// accepted so nothing that ever held the old contract breaks.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

/** multer's errors are thrown, not returned; turn the ones a customer can act on into plain words. */
function acceptPhoto(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'That photo is too large to send. Anything under 15MB is fine.'
        : 'We could not read that photo. Try another, or send your review without it.';
      return res.status(400).json({ error: message });
    }
    next(err);
  });
}

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

/** Multipart fields arrive as strings, JSON as booleans; both mean the same tick. */
function truthy(v) {
  return v === true || ['1', 'true', 'on', 'yes'].includes(String(v || '').toLowerCase());
}

const ALREADY = {
  error: 'You have already left a review for this order. Thank you.',
  alreadySubmitted: true,
};

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
 * Fields: rating, body, authorDisplay, consentToPublish, and optionally a file
 * named `photo`.
 *
 * Nothing here auto-publishes. A stored row is 'pending' until the owner looks
 * at it, so a submission can never put words or a picture on the site by
 * itself. The incentivised flag is deliberately NOT accepted from this
 * endpoint: only the shop knows what was comped, so only the shop sets it.
 */
router.post('/review/:token', acceptPhoto, express.json(), async (req, res) => {
  const db = req.app.locals.db;
  const order = findOrderByToken(db, req.params.token);
  if (!order) return res.status(404).json({ error: 'We could not find that order.' });

  if (NOT_YET_A_PURCHASE.includes(order.status)) {
    return res.status(410).json({ error: 'This link is not ready yet.' });
  }

  // One review per order. The UNIQUE index is the real guarantee; this is the
  // friendly path, so it answers kindly rather than as an error.
  const existing = db.get('SELECT id FROM customer_reviews WHERE order_id = ?', [order.id]);
  if (existing) return res.status(409).json(ALREADY);

  const b = req.body || {};
  const rating = Number(b.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: 'Please choose a rating from one to five stars.' });
  }

  const body = String(b.body || '').trim().slice(0, MAX_BODY);
  const authorDisplay = String(b.authorDisplay || '').trim().slice(0, MAX_AUTHOR);
  const consent = truthy(b.consentToPublish) ? 1 : 0;

  // The photo is normalised BEFORE the row exists, so a file we cannot read
  // costs the customer a retry rather than a half-saved review. It is keyed by
  // order id, so nothing is minted that could outlive a refused insert.
  let photoPath = null;
  if (req.file && req.file.buffer && req.file.buffer.length) {
    try {
      photoPath = await reviewPhotos.store(order.id, req.file.buffer);
    } catch (err) {
      console.error(`Review photo for order ${order.id} could not be processed:`, err.message);
      return res.status(400).json({
        error: 'We could not read that photo. Try another, or send your review without it.',
      });
    }
  }

  try {
    db.run(
      `INSERT INTO customer_reviews
         (order_id, rating, body, author_display, consent_to_publish, photo_path, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [order.id, rating, body || null, authorDisplay || null, consent, photoPath]
    );
  } catch (err) {
    // The UNIQUE index catching a racing double-submit lands here. The photo
    // that just landed belongs to the row that won, not this one.
    console.error(`Review submit failed for order ${order.id}:`, err.message);
    const nowExists = db.get('SELECT photo_path FROM customer_reviews WHERE order_id = ?', [order.id]);
    if (nowExists) {
      if (photoPath && nowExists.photo_path !== photoPath) reviewPhotos.remove(photoPath);
      return res.status(409).json(ALREADY);
    }
    if (photoPath) reviewPhotos.remove(photoPath);
    return res.status(500).json({ error: 'We could not save that. Please try again.' });
  }

  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [order.id, 'review_submitted', JSON.stringify({
      rating,
      consentToPublish: consent === 1,
      hasBody: !!body,
      hasPhoto: !!photoPath,
      submittedAt: new Date().toISOString(),
    })]
  );

  console.log(`Customer review submitted for order ${order.id}: ${rating}/5, consent=${consent === 1}, photo=${!!photoPath}`);
  res.json({ success: true, hasPhoto: !!photoPath });
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

/**
 * GET /api/reviews/:id/photo
 * The photo exists on disk from the moment it is submitted, but it is reachable
 * from outside only while the review is published with consent. Hiding the
 * review makes this a 404 again, which is the takedown.
 */
router.get('/reviews/:id/photo', (req, res) => {
  const db = req.app.locals.db;
  const row = db.get(
    `SELECT photo_path FROM customer_reviews
      WHERE id = ? AND photo_path IS NOT NULL AND ${customerReviews.PUBLISHED_WHERE}`,
    [req.params.id]
  );
  const abs = row && reviewPhotos.absolutePath(row.photo_path);
  if (!abs) return res.status(404).end();

  res.set('Cache-Control', 'public, max-age=86400');
  res.type('image/jpeg');
  res.sendFile(abs, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

module.exports = router;
