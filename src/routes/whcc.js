/**
 * WHCC Order Submit API – Admin/Test Routes
 * For testing WHCC connectivity, browsing catalog, managing product mappings,
 * and submitting test orders to the sandbox.
 */

const express = require('express');
const router = express.Router();
const whccOrderApi = require('../services/whccOrderApi');
const whccCatalog = require('../services/whccCatalog');

/**
 * GET /api/whcc/health
 * Test WHCC Order API authentication.
 */
router.get('/health', async (req, res) => {
  try {
    const token = await whccOrderApi.getAccessToken();
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
 * GET /api/whcc/catalog
 * Fetch the full WHCC product catalog (cached 24hrs).
 */
router.get('/catalog', async (req, res) => {
  const db = req.app.locals.db;
  const force = req.query.refresh === 'true';

  try {
    let data;
    if (force) {
      data = await whccCatalog.refreshCatalog('order', db, () => whccOrderApi.fetchCatalog());
    } else {
      data = await whccCatalog.getCatalog('order', db, () => whccOrderApi.fetchCatalog());
    }

    const categories = data?.Categories || [];
    const productCount = categories.reduce((sum, c) => sum + (c.ProductList || []).length, 0);
    res.json({ categoryCount: categories.length, productCount, catalog: data });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/whcc/catalog/search?q=8x10
 * Search catalog products by name/description.
 */
router.get('/catalog/search', async (req, res) => {
  const db = req.app.locals.db;
  const query = (req.query.q || '').toLowerCase();

  if (!query) {
    return res.status(400).json({ error: 'Query parameter q is required' });
  }

  try {
    const data = await whccCatalog.getCatalog('order', db, () => whccOrderApi.fetchCatalog());
    const categories = data?.Categories || [];

    // Search across all categories and products
    const results = [];
    for (const cat of categories) {
      for (const product of (cat.ProductList || [])) {
        const searchable = `${cat.Name} ${product.Name}`.toLowerCase();
        if (searchable.includes(query)) {
          results.push({
            category: cat.Name,
            productId: product.Id,
            name: product.Name,
            nodeId: (product.ProductNodes || [])[0]?.DP2NodeID,
            attributes: (product.AttributeCategories || []).map(ac => ({
              id: ac.Id,
              name: ac.AttributeCategoryName,
              requiredLevel: ac.RequiredLevel,
              options: (ac.Attributes || []).map(a => ({ id: a.Id, name: a.AttributeName }))
            }))
          });
        }
      }
    }

    res.json({ query, resultCount: results.length, results });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * GET /api/whcc/product-map
 * List all SKU → WHCC product mappings.
 */
router.get('/product-map', (req, res) => {
  const db = req.app.locals.db;
  const mappings = whccCatalog.getAllMappings(db);
  res.json({ count: mappings.length, mappings });
});

/**
 * POST /api/whcc/product-map
 * Set a SKU → WHCC product mapping.
 * Body: { sku, productUid, nodeId?, attributeUids?, description? }
 */
router.post('/product-map', (req, res) => {
  const db = req.app.locals.db;
  const { sku, productUid, nodeId, attributeUids, description } = req.body;

  if (!sku || !productUid) {
    return res.status(400).json({ error: 'sku and productUid are required' });
  }

  whccCatalog.setProductMapping(db, { sku, productUid, nodeId, attributeUids, description });

  const saved = whccCatalog.getProductMapping(sku, db);
  res.json({ success: true, mapping: saved });
});

/**
 * POST /api/whcc/product-map/auto
 * Auto-detect WHCC products matching our print sizes.
 */
router.post('/product-map/auto', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const data = await whccCatalog.getCatalog('order', db, () => whccOrderApi.fetchCatalog());
    const suggestions = whccCatalog.autoMapProducts(data, db);
    res.json({ suggestions });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/**
 * POST /api/whcc/test-order
 * Send a test order to the WHCC sandbox.
 * Body: { imageUrl?, shipTo? } – uses defaults for missing fields.
 */
router.post('/test-order', async (req, res) => {
  const db = req.app.locals.db;
  const { imageUrl, shipTo } = req.body;

  // Use 8x10 mapping by default, or first available
  const mapping = whccCatalog.getProductMapping(req.body.sku || 'framed-8x10', db)
    || whccCatalog.getAllMappings(db)[0];

  if (!mapping) {
    return res.status(400).json({
      error: 'No product mappings configured.',
      hint: 'GET /api/whcc/catalog then POST /api/whcc/product-map'
    });
  }

  // Default attributes validated against sandbox (Lexington Black, Single White Mat, Lustre)
  const defaultItemAttrs = [623, 602, 560, 1922, 2495, 617, 627, 1878, 1907];
  const testPayload = {
    EntryId: `test-${Date.now()}`,
    Orders: [{
      SequenceNumber: 1,
      ShipToAddress: shipTo || {
        Name: 'Test Order',
        Addr1: '3412 S 300 E',
        City: 'Salt Lake City',
        State: 'UT',
        Zip: '84115',
        Country: 'US'
      },
      ShipFromAddress: {
        Name: 'Still Beside Me',
        Addr1: '3412 S 300 E',
        City: 'Salt Lake City',
        State: 'UT',
        Zip: '84115',
        Country: 'US'
      },
      OrderAttributes: [
        { AttributeUID: 96 },   // Drop Ship to Client
        { AttributeUID: 100 }   // USA Trackable 3 days or less
      ],
      OrderItems: [{
        ProductUID: Number(mapping.whcc_product_uid),
        Quantity: 1,
        ItemAssets: [{
          ProductNodeID: 10000,
          AssetPath: imageUrl || 'https://picsum.photos/id/237/3000/2400.jpg',
          ImageHash: '',
          AutoRotate: true
        }],
        ItemAttributes: defaultItemAttrs.map(uid => ({ AttributeUID: uid }))
      }]
    }]
  };

  try {
    const importResult = await whccOrderApi.importOrder(testPayload);
    const confirmationId = importResult.ConfirmationID || importResult.ConfirmationId;

    // Track it
    db.run(
      `INSERT INTO whcc_orders (order_id, entry_id, confirmation_id, status, request_json, response_json)
       VALUES (?, ?, ?, 'imported', ?, ?)`,
      ['test-order', testPayload.EntryId, String(confirmationId),
       JSON.stringify(testPayload), JSON.stringify(importResult)]
    );

    // Submit to sandbox
    const submitResult = await whccOrderApi.submitOrder(confirmationId);

    db.run(
      `UPDATE whcc_orders SET status = 'submitted', updated_at = datetime('now')
       WHERE entry_id = ?`,
      [testPayload.EntryId]
    );

    res.json({
      success: true,
      entryId: testPayload.EntryId,
      confirmationId,
      importResult,
      submitResult
    });
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.body });
  }
});

/**
 * POST /api/whcc/orders/:id/submit
 * Submit a real order to WHCC for production.
 */
router.post('/orders/:id/submit', async (req, res) => {
  const db = req.app.locals.db;
  const orderId = req.params.id;

  try {
    const result = await whccOrderApi.placeOrder(orderId, db);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, details: err.body });
  }
});

/**
 * GET /api/whcc/orders/:id/status
 * Check WHCC fulfillment status for an order.
 */
router.get('/orders/:id/status', (req, res) => {
  const db = req.app.locals.db;
  const orderId = req.params.id;

  const whccOrders = db.all(
    'SELECT * FROM whcc_orders WHERE order_id = ? ORDER BY created_at DESC',
    [orderId]
  );

  if (whccOrders.length === 0) {
    return res.status(404).json({ error: 'No WHCC fulfillment found for this order' });
  }

  res.json({
    orderId,
    fulfillments: whccOrders.map(o => ({
      entryId: o.entry_id,
      confirmationId: o.confirmation_id,
      status: o.status,
      trackingNumber: o.tracking_number,
      trackingCarrier: o.tracking_carrier,
      trackingUrl: o.tracking_url,
      error: o.error_message,
      createdAt: o.created_at,
      updatedAt: o.updated_at
    }))
  });
});

/**
 * POST /api/whcc/webhook/register
 * Register our webhook callback URL with WHCC.
 */
router.post('/webhook/register', async (req, res) => {
  const baseUrl = req.body.baseUrl || process.env.BASE_URL;
  const callbackUrl = `${baseUrl}/api/whcc-webhooks/callback`;

  try {
    const result = await whccOrderApi.registerWebhook(callbackUrl);
    res.json({ success: true, callbackUrl, result });
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.body });
  }
});

/**
 * POST /api/whcc/webhook/verify
 * Complete webhook verification with the code WHCC sent.
 * Body: { verifier: "the-code-from-whcc" }
 */
router.post('/webhook/verify', async (req, res) => {
  const { verifier } = req.body;

  if (!verifier) {
    return res.status(400).json({ error: 'verifier is required' });
  }

  try {
    const result = await whccOrderApi.verifyWebhook(verifier);
    res.json({ success: true, result });
  } catch (err) {
    res.status(502).json({ error: err.message, details: err.body });
  }
});

module.exports = router;
