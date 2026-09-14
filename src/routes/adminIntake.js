/**
 * Manual intake for marketplace orders — the gated second door.
 *
 * GET  /admin/intake        the form
 * POST /admin/api/intake    create the order, then hand back its review link
 *
 * An Etsy buyer pays on Etsy and answers our five questions there. Nothing in
 * this system sees that. Somebody has to carry the answers across, and until
 * the Etsy app is approved that somebody is a person with this form open in
 * one tab and the Etsy order in another.
 *
 * Gated with the SAME requireAdmin the dashboard uses: this door creates real
 * orders that end at a real printer, so it sits behind the shop password like
 * everything else that can move money or materials.
 *
 * The route is thin on purpose. Every decision that matters (which frames are
 * real, how long a field may be, what a photo must survive, one order per
 * receipt) lives in orderIntake.js, because the webhook will need all of it
 * too and must not reimplement any of it.
 */

const express = require('express');
const path = require('path');
const multer = require('multer');
const router = express.Router();

const { requireAdmin } = require('./adminDashboard');
const orderIntake = require('../services/orderIntake');

// Buyers photograph pets on phones; 15MB covers a modern HEIC comfortably.
// Memory storage because the image pipeline wants a buffer, and these files
// are small, few, and processed immediately.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 3 },
});

router.get('/intake', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'intake.html'));
});

router.post('/api/intake', requireAdmin, upload.array('photos', 3), async (req, res) => {
  const db = req.app.locals.db;
  const b = req.body || {};

  try {
    if (!req.files || !req.files.length) {
      return res.status(400).json({ error: 'Add at least one photo of their pet.' });
    }

    const result = await orderIntake.createFromMarketplace(db, {
      source: 'etsy',
      etsyReceiptId: b.etsyReceiptId,
      sku: b.sku,
      frameChoice: b.frameChoice,
      totalCents: b.totalCents ? Math.round(Number(b.totalCents) * 100) : undefined,
      ownPoem: b.ownPoem,
      notes: b.notes,
      fields: {
        petName: b.petName,
        petType: b.petType,
        birthDate: b.birthDate,
        passDate: b.passDate,
        personality: b.personality,
        favoriteMemory: b.favoriteMemory,
        petNicknames: b.petNicknames,
        familyName: b.familyName,
      },
      shipping: b.shipName ? {
        name: b.shipName,
        line1: b.shipLine1,
        line2: b.shipLine2 || '',
        city: b.shipCity,
        state: b.shipState,
        zip: b.shipZip,
        country: b.shipCountry || 'US',
      } : undefined,
      photos: req.files.map(f => ({ buffer: f.buffer, originalName: f.originalname })),
    });

    res.json({
      success: true,
      orderId: result.orderId,
      shortId: result.orderId.substring(0, 8).toUpperCase(),
      reviewUrl: `/admin/review/${result.adminToken}`,
      photoQuality: result.photoQuality,
    });
  } catch (err) {
    // A repeat receipt is the expected mistake, not a failure: say which order
    // already holds it so the same sale is never made twice.
    if (err.code === 'DUPLICATE_RECEIPT') {
      const dupe = db.get('SELECT admin_token FROM orders WHERE id = ?', [err.orderId]);
      return res.status(409).json({
        error: err.message,
        orderId: err.orderId,
        reviewUrl: dupe ? `/admin/review/${dupe.admin_token}` : null,
      });
    }
    console.error('[intake] failed:', err.message);
    res.status(400).json({ error: err.message || 'Could not create that order.' });
  }
});

module.exports = router;
