/**
 * Luma Prints Admin/Setup Routes
 * For discovering store IDs, product categories, and option IDs.
 * Run GET /api/luma/setup once after configuring API credentials.
 */

const express = require('express');
const router = express.Router();
const lumaOrderApi = require('../services/lumaOrderApi');

/**
 * GET /api/luma/health
 * Test Luma API authentication.
 */
router.get('/health', async (req, res) => {
  try {
    const stores = await lumaOrderApi.getStores();
    res.json({
      status: 'ok',
      environment: process.env.LUMA_ENVIRONMENT || 'sandbox',
      authenticated: true,
      storeCount: Array.isArray(stores) ? stores.length : 0,
    });
  } catch (err) {
    res.status(502).json({
      status: 'error',
      environment: process.env.LUMA_ENVIRONMENT || 'sandbox',
      authenticated: false,
      error: err.message,
      details: err.body,
    });
  }
});

/**
 * GET /api/luma/setup
 * Discover storeId, product categories, subcategories, and option IDs.
 * Returns everything needed to configure LUMA_CONFIG in lumaOrderApi.js.
 */
router.get('/setup', async (req, res) => {
  try {
    // 1. Get stores
    const stores = await lumaOrderApi.getStores();

    // 2. Get product categories
    const categories = await lumaOrderApi.getCategories();

    // 3. For each subcategory that looks like framed prints, fetch options
    const subcategoryDetails = [];
    if (Array.isArray(categories)) {
      for (const cat of categories) {
        const subcategories = cat.subcategories || cat.Subcategories || [];
        for (const sub of subcategories) {
          const subId = sub.id || sub.Id;
          const subName = sub.name || sub.Name || '';
          // Fetch options for subcategories related to framing/fine art
          if (subName.toLowerCase().includes('frame') ||
              subName.toLowerCase().includes('fine art') ||
              subName.toLowerCase().includes('print')) {
            try {
              const options = await lumaOrderApi.getSubcategoryOptions(subId);
              subcategoryDetails.push({
                subcategoryId: subId,
                name: subName,
                categoryName: cat.name || cat.Name,
                options,
              });
            } catch (err) {
              subcategoryDetails.push({
                subcategoryId: subId,
                name: subName,
                categoryName: cat.name || cat.Name,
                error: err.message,
              });
            }
          }
        }
      }
    }

    res.json({
      stores,
      categories,
      relevantSubcategories: subcategoryDetails,
      instructions: {
        step1: 'Find your storeId from the stores array above',
        step2: 'Set LUMA_STORE_ID in your .env file',
        step3: 'Find the "Framed Fine Art Paper" subcategoryId from relevantSubcategories',
        step4: 'Update LUMA_CONFIG.subcategoryId in src/services/lumaOrderApi.js',
        step5: 'Find frame color, mat, and paper option IDs from the options arrays',
        step6: 'Update LUMA_CONFIG.frameOptions and LUMA_CONFIG.defaultOptions',
      },
    });
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.body });
  }
});

/**
 * GET /api/luma/subcategory/:id/options
 * Fetch options for a specific subcategory (for manual exploration).
 */
router.get('/subcategory/:id/options', async (req, res) => {
  try {
    const options = await lumaOrderApi.getSubcategoryOptions(req.params.id);
    res.json({ subcategoryId: req.params.id, options });
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.body });
  }
});

/**
 * GET /api/luma/orders/:id/status
 * Check Luma fulfillment status for an order.
 */
router.get('/orders/:id/status', (req, res) => {
  const db = req.app.locals.db;
  const orderId = req.params.id;

  const lumaOrders = db.all(
    'SELECT * FROM luma_orders WHERE order_id = ? ORDER BY created_at DESC',
    [orderId]
  );

  if (lumaOrders.length === 0) {
    return res.status(404).json({ error: 'No Luma fulfillment found for this order' });
  }

  res.json({
    orderId,
    fulfillments: lumaOrders.map(o => ({
      lumaOrderNumber: o.luma_order_number,
      status: o.status,
      trackingNumber: o.tracking_number,
      trackingCarrier: o.tracking_carrier,
      trackingUrl: o.tracking_url,
      error: o.error_message,
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    })),
  });
});

/**
 * GET /api/luma/orders/:orderNumber/shipments
 * Fetch shipment info from Luma for a specific order.
 */
router.get('/orders/:orderNumber/shipments', async (req, res) => {
  try {
    const shipments = await lumaOrderApi.getShipments(req.params.orderNumber);
    res.json({ orderNumber: req.params.orderNumber, shipments });
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.body });
  }
});

/**
 * POST /api/luma/webhook/register
 * Register our webhook callback URL with Luma.
 */
router.post('/webhook/register', async (req, res) => {
  const storeId = req.body.storeId || lumaOrderApi.LUMA_CONFIG.storeId;
  const baseUrl = req.body.baseUrl || process.env.BASE_URL;
  const callbackUrl = `${baseUrl}/api/luma-webhooks`;

  if (!storeId) {
    return res.status(400).json({
      error: 'storeId required. Set LUMA_STORE_ID or pass in body.',
    });
  }

  try {
    const result = await lumaOrderApi.subscribeWebhook(storeId, callbackUrl);
    res.json({ success: true, callbackUrl, result });
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.body });
  }
});

/**
 * POST /api/luma/orders/:id/submit
 * Manually submit an order to Luma (retry or manual fulfillment).
 */
router.post('/orders/:id/submit', async (req, res) => {
  const db = req.app.locals.db;
  const orderId = req.params.id;

  try {
    const result = await lumaOrderApi.placeOrder(orderId, db);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.body });
  }
});

module.exports = router;
