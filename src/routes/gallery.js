/**
 * GET /api/gallery — the real customer pieces published to the homepage.
 *
 * Read-only and unauthenticated, because everything it returns is already
 * printed on an image the same page is showing. The gate is not this route, it
 * is galleryPieces.published(): a piece appears only once the shop has given
 * that order a gallery_slug, and only the fields Terms section 5 covers ever
 * leave the database.
 *
 * Deliberately NOT part of api.js: that router carries the ordering flow, with
 * multer and generous body limits behind it. This is a public read with no
 * input at all, and keeping it separate means it never inherits an upload
 * middleware by accident.
 */

const express = require('express');
const router = express.Router();
const galleryPieces = require('../services/galleryPieces');

router.get('/gallery', (req, res) => {
  const db = req.app.locals.db;
  if (!db) return res.json({ pieces: [] });

  try {
    const pieces = galleryPieces.published(db);
    // Short cache: a takedown is one UPDATE, and it should take effect in
    // minutes rather than whenever a CDN feels like it. The images behind
    // these URLs are immutable and cached hard; this index is not.
    res.set('Cache-Control', 'public, max-age=300');
    res.json({ pieces });
  } catch (err) {
    // A broken gallery must never take the homepage with it. An empty list
    // leaves the demo pieces standing, which is a correct page.
    console.error('[gallery] read failed:', err.message);
    res.json({ pieces: [] });
  }
});

module.exports = router;
