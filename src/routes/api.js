const express = require('express');
const multer = require('multer');
const router = express.Router();
const imageProcessor = require('../services/imageProcessor');
const storage = require('../services/storage');

// Multer: store in memory for processing pipeline, then save to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|webp|heic|heif/i;
    const ext = file.originalname.split('.').pop();
    if (allowed.test(ext) || allowed.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, WebP, and HEIC images are accepted'));
    }
  }
});

// Health check
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'still-beside-me', timestamp: new Date().toISOString() });
});

// ── Image Upload ──────────────────────────────────────────────

/**
 * POST /api/images/upload
 * Full pipeline: HEIC convert → thumbnail → quality assess → smart crop → store
 */
router.post('/images/upload', upload.single('photo'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    const slotId = req.body.slotId || 'main';
    const printWidth = parseFloat(req.body.printWidth) || 16;
    const printHeight = parseFloat(req.body.printHeight) || 20;

    // Process: convert, thumbnail, quality, crop
    const result = await imageProcessor.processUpload(
      req.file.buffer,
      req.file.originalname,
      printWidth,
      printHeight
    );

    // Store original (or HEIC-converted) and thumbnail
    const originalName = result.convertedFromHeic
      ? req.file.originalname.replace(/\.heic$/i, '.jpg').replace(/\.heif$/i, '.jpg')
      : req.file.originalname;

    const stored = storage.storeFile(result.processedBuffer, originalName);
    const thumb = storage.storeThumbnail(result.thumbnailBuffer, stored.filename);

    // Save metadata to session
    if (!req.session.photos) req.session.photos = {};
    req.session.photos[slotId] = {
      originalPath: stored.relativePath,
      thumbnailPath: thumb.relativePath,
      originalUrl: storage.toUrl(stored.relativePath),
      thumbnailUrl: storage.toUrl(thumb.relativePath),
      dimensions: result.dimensions,
      quality: result.quality,
      crop: result.crop,
      uploadedAt: new Date().toISOString()
    };

    res.json({
      success: true,
      slotId,
      originalUrl: storage.toUrl(stored.relativePath),
      thumbnailUrl: storage.toUrl(thumb.relativePath),
      dimensions: result.dimensions,
      quality: result.quality,
      crop: result.crop,
      convertedFromHeic: result.convertedFromHeic
    });
  } catch (err) {
    console.error('Upload failed:', err);
    res.status(500).json({ error: 'Upload failed. Please try again.' });
  }
});

/**
 * POST /api/images/assess-quality
 * Re-assess quality at a different print size (e.g., when customer changes product size)
 */
router.post('/images/assess-quality', (req, res) => {
  const { imageWidth, imageHeight, printWidth, printHeight } = req.body;

  if (!imageWidth || !imageHeight) {
    return res.status(400).json({ error: 'Image dimensions required' });
  }

  const quality = imageProcessor.assessQuality(
    imageWidth, imageHeight,
    printWidth || 16, printHeight || 20
  );

  res.json(quality);
});

/**
 * POST /api/images/analyze-crop
 * Re-analyze crop for a different slot or after re-upload
 */
router.post('/images/analyze-crop', async (req, res) => {
  try {
    const { slotId } = req.body;
    const photo = req.session.photos && req.session.photos[slotId];

    if (!photo) {
      return res.status(404).json({ error: 'No photo found for this slot' });
    }

    const absolutePath = storage.resolve(photo.originalPath);
    const fs = require('fs');
    const buffer = fs.readFileSync(absolutePath);
    const crop = await imageProcessor.analyzeCrop(buffer);

    // Update session
    req.session.photos[slotId].crop = crop;

    res.json(crop);
  } catch (err) {
    console.error('Crop analysis failed:', err);
    res.status(500).json({ error: 'Crop analysis failed' });
  }
});

// ── Poems ─────────────────────────────────────────────────────

const poems = require('../data/poems');

/**
 * GET /api/poems – List poems with preview text.
 * Optional ?category= filter: returns matching + universal poems.
 */
router.get('/poems', (req, res) => {
  const category = req.query.category;
  const filtered = category
    ? poems.filter(p => p.category === category || p.category === 'universal')
    : poems;

  res.json(filtered.map(p => ({
    id: p.id,
    title: p.title,
    author: p.author,
    category: p.category,
    preview: p.preview
  })));
});

/**
 * GET /api/poems/:id – Full poem text
 */
router.get('/poems/:id', (req, res) => {
  const poem = poems.find(p => p.id === req.params.id);
  if (!poem) {
    return res.status(404).json({ error: 'Poem not found' });
  }
  res.json(poem);
});

/**
 * POST /api/poems/generate – AI poem generation via Anthropic Claude.
 * Falls back to template-based poem when API key is missing.
 * Rate limited: 5 generations per session per hour.
 * Caches all generated poems in the session so users can browse previous versions.
 */
const poemGenerator = require('../services/poemGenerator');

router.post('/poems/generate', async (req, res) => {
  // Rate limiting – 5 per session per hour
  if (!req.session.poemGenerations) req.session.poemGenerations = [];

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  req.session.poemGenerations = req.session.poemGenerations.filter(t => t > oneHourAgo);

  if (req.session.poemGenerations.length >= 5) {
    return res.status(429).json({
      error: 'You\'ve generated several poems recently. Please wait a bit before trying again.',
      retryAfter: Math.ceil((req.session.poemGenerations[0] + 60 * 60 * 1000 - Date.now()) / 1000)
    });
  }

  try {
    const result = await poemGenerator.generate(req.body);

    // Track generation timestamp
    req.session.poemGenerations.push(Date.now());

    // Cache poem in session history
    if (!req.session.poemHistory) req.session.poemHistory = [];
    req.session.poemHistory.push({
      poem: result.poem,
      generationId: result.generationId,
      stubbed: result.stubbed,
      createdAt: new Date().toISOString()
    });

    res.json(result);
  } catch (err) {
    console.error('Poem generation error:', err);
    res.status(500).json({ error: 'Something went wrong creating the poem. Please try again.' });
  }
});

// Error handler for multer
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 50MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err.message && err.message.includes('Only JPEG')) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

module.exports = router;
