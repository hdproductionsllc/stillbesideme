/**
 * WHCC Editor API – Test Routes
 * For testing the white-label design editor integration.
 */

const express = require('express');
const router = express.Router();
const whccEditorApi = require('../services/whccEditorApi');
const whccCatalog = require('../services/whccCatalog');

/**
 * GET /api/whcc-editor/health
 * Test Editor API authentication.
 */
router.get('/health', async (req, res) => {
  try {
    const token = await whccEditorApi.getEditorToken();
    res.json({
      status: 'ok',
      environment: process.env.WHCC_ENVIRONMENT || 'unknown',
      authenticated: true,
      tokenPreview: token ? `${String(token).substring(0, 12)}...` : null
    });
  } catch (err) {
    res.status(502).json({
      status: 'error',
      environment: process.env.WHCC_ENVIRONMENT || 'unknown',
      authenticated: false,
      error: err.message
    });
  }
});

/**
 * GET /api/whcc-editor/products
 * Fetch available editor products (cached 24hrs).
 */
router.get('/products', async (req, res) => {
  const db = req.app.locals.db;
  const force = req.query.refresh === 'true';

  try {
    let data;
    if (force) {
      data = await whccCatalog.refreshCatalog('editor', db, () => whccEditorApi.fetchCatalog());
    } else {
      data = await whccCatalog.getCatalog('editor', db, () => whccEditorApi.fetchCatalog());
    }

    res.json({ products: data });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/whcc-editor/designs
 * Fetch available design templates.
 */
router.get('/designs', async (req, res) => {
  try {
    const designs = await whccEditorApi.getDesigns();
    res.json({ designs });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/whcc-editor/session
 * Create a new editor session. Returns a redirect URL.
 * Body: { userId?, productId, designId, options? }
 */
router.post('/session', async (req, res) => {
  const { userId, productId, designId, ...options } = req.body;

  if (!productId) {
    return res.status(400).json({ error: 'productId is required' });
  }

  try {
    const result = await whccEditorApi.createEditor(
      userId || 'test-user',
      productId,
      designId,
      options
    );
    res.json({ success: true, editor: result });
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.body });
  }
});

/**
 * POST /api/whcc-editor/export/:id
 * Export editor data for a completed design.
 */
router.post('/export/:id', async (req, res) => {
  try {
    const result = await whccEditorApi.exportEditor(req.params.id);
    res.json({ success: true, export: result });
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.body });
  }
});

/**
 * POST /api/whcc-editor/order/create
 * Create an order from exported editor data.
 * Body: { editorId, shipTo, ... }
 */
router.post('/order/create', async (req, res) => {
  try {
    const result = await whccEditorApi.createOrder(req.body);
    res.json({ success: true, order: result });
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.body });
  }
});

/**
 * POST /api/whcc-editor/order/:id/confirm
 * Confirm an editor order for production.
 */
router.post('/order/:id/confirm', async (req, res) => {
  try {
    const result = await whccEditorApi.confirmOrder(req.params.id);
    res.json({ success: true, confirmation: result });
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.body });
  }
});

module.exports = router;
