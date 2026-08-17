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
      palette: result.palette,
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
      palette: result.palette,
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
 * POST /api/poem-fit
 *
 * How large will these words actually print, and what would fix it if the
 * answer is "too small"? Answered by running the real renderer, so the builder
 * never has to compute it a second way. That duplication is exactly what let a
 * 7.5pt poem ship without a warning: the builder's copy of the maths was still
 * measuring a printed mat we stopped printing.
 *
 * Cheap: lays out type, builds no image, reads no photo.
 */
router.post('/poem-fit', (req, res) => {
  const { sku, layout, poemText, templateId } = req.body || {};
  if (!sku || !layout || !poemText) {
    return res.status(400).json({ error: 'sku, layout and poemText are required' });
  }
  if (String(poemText).length > 8000) {
    return res.status(400).json({ error: 'poemText too long' });
  }

  try {
    const poemFit = require('../services/poemFit');
    const { loadTemplate } = require('../services/tributeRenderer');
    const template = loadTemplate(templateId || 'pet-tribute');
    const sellableSkus = (template.printProducts || [])
      .filter((p) => p.fulfillment !== 'digital')
      .map((p) => p.sku);

    const result = poemFit.assess({
      sku,
      layout,
      templateId: templateId || 'pet-tribute',
      sellableSkus,
      // Only the poem affects the fit; the header and footer are sized from the
      // panel, so representative values are enough and no customer data is sent.
      tributeData: {
        name: req.body.name || 'Name',
        nickname: req.body.nickname || '',
        birthDate: req.body.birthDate || '',
        passDate: req.body.passDate || '',
        familyName: req.body.familyName || '',
        poemText,
      },
    });
    if (!result) return res.status(400).json({ error: 'Could not measure that piece' });
    res.json(result);
  } catch (err) {
    console.error('[poem-fit]', err.message);
    res.status(500).json({ error: 'Could not measure that piece' });
  }
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
 * Caches all generated poems in the session so users can browse previous versions.
 *
 * Two surfaces share this endpoint on one session, so each gets its own hourly
 * budget. The customizer always posts a templateId (the poem is being written
 * INTO a product); the free poem-generator tool never does. Anything without a
 * templateId therefore spends the free budget only — a visitor who plays with
 * the free tool can never arrive at the customizer already locked out.
 *   customizer 10/hour — the UI ceiling is MAX_REGENERATIONS (3) per format ×
 *     2 formats (poem + letter), plus headroom for a reload, a template switch
 *     or a second pet. A buyer must never be 429'd mid-purchase.
 *   free tool 5/hour — a first poem plus a few retries. The surface is
 *     unauthenticated and every call costs a model request, so it stays tight.
 */
const poemGenerator = require('../services/poemGenerator');

const POEM_BUDGETS = {
  customizer: { key: 'poemGenerations', max: 10 },
  tool: { key: 'poemToolGenerations', max: 5 }
};

router.post('/poems/generate', async (req, res) => {
  const budget = (req.body && req.body.templateId) ? POEM_BUDGETS.customizer : POEM_BUDGETS.tool;
  if (!req.session[budget.key]) req.session[budget.key] = [];

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  req.session[budget.key] = req.session[budget.key].filter(t => t > oneHourAgo);

  if (req.session[budget.key].length >= budget.max) {
    return res.status(429).json({
      error: 'You\'ve generated several poems recently. Please wait a bit before trying again.',
      retryAfter: Math.ceil((req.session[budget.key][0] + 60 * 60 * 1000 - Date.now()) / 1000)
    });
  }

  try {
    const result = await poemGenerator.generate(req.body);

    // Track generation timestamp
    req.session[budget.key].push(Date.now());

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

// ── Sympathy Messages ────────────────────────────────────────

const sympathyGenerator = require('../services/sympathyGenerator');

/**
 * POST /api/sympathy/generate – AI sympathy message generation.
 * Rate limited: 3 per session per hour.
 */
router.post('/sympathy/generate', async (req, res) => {
  if (!req.session.sympathyGenerations) req.session.sympathyGenerations = [];

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  req.session.sympathyGenerations = req.session.sympathyGenerations.filter(t => t > oneHourAgo);

  if (req.session.sympathyGenerations.length >= 3) {
    return res.status(429).json({
      error: 'You\'ve generated several messages recently. Please wait a bit before trying again.',
      retryAfter: Math.ceil((req.session.sympathyGenerations[0] + 60 * 60 * 1000 - Date.now()) / 1000)
    });
  }

  try {
    const result = await sympathyGenerator.generate(req.body);

    req.session.sympathyGenerations.push(Date.now());
    if (!req.session.sympathyHistory) req.session.sympathyHistory = [];
    req.session.sympathyHistory.push({
      messages: result.messages,
      generationId: result.generationId,
      stubbed: result.stubbed,
      createdAt: new Date().toISOString()
    });

    res.json(result);
  } catch (err) {
    console.error('Sympathy generation error:', err);
    res.status(500).json({ error: 'Something went wrong creating the message. Please try again.' });
  }
});

/**
 * POST /api/gift-note/generate – one editable draft of the sender's note.
 *
 * Rate limited separately from /sympathy/generate and more generously (8/hour).
 * The sympathy tool's 3/hour is tuned for a free SEO toy open to the whole
 * internet; this runs inside the customizer for someone who is mid-purchase and
 * already spending a 5/hour poem budget on the same session. A buyer who taps
 * "help me write it" a few times while drafting must not hit a wall — the cost
 * of a Haiku call is nothing next to the cost of stalling a checkout.
 */
router.post('/gift-note/generate', async (req, res) => {
  if (!req.session.giftNoteGenerations) req.session.giftNoteGenerations = [];

  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  req.session.giftNoteGenerations = req.session.giftNoteGenerations.filter(t => t > oneHourAgo);

  if (req.session.giftNoteGenerations.length >= 8) {
    return res.status(429).json({
      error: 'You\'ve drafted several notes recently. Please wait a bit before trying again.',
      retryAfter: Math.ceil((req.session.giftNoteGenerations[0] + 60 * 60 * 1000 - Date.now()) / 1000),
    });
  }

  try {
    const result = await sympathyGenerator.generateGiftNote(req.body || {});
    req.session.giftNoteGenerations.push(Date.now());
    res.json(result);
  } catch (err) {
    console.error('Gift note generation error:', err);
    res.status(500).json({ error: 'Something went wrong drafting the note. Please try again.' });
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
