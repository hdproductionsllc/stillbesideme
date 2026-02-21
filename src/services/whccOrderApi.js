/**
 * WHCC Order Submit API Client
 * Handles authentication, catalog fetching, order import/submit, and webhook registration.
 * Docs: https://developer.whcc.com/order-submit-api
 */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const API_URL = () => process.env.WHCC_ORDER_API_URL || 'https://sandbox.apps.whcc.com';
const CONSUMER_KEY = () => process.env.WHCC_CONSUMER_KEY;
const CONSUMER_SECRET = () => process.env.WHCC_CONSUMER_SECRET;
const BASE_URL = () => process.env.BASE_URL || 'http://localhost:3001';

// In-memory token cache (55-minute TTL, tokens last 60 min)
let tokenCache = { token: null, expiresAt: 0 };

/**
 * Get an access token from WHCC. Cached for 55 minutes.
 */
async function getAccessToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const key = CONSUMER_KEY();
  const secret = CONSUMER_SECRET();
  if (!key || !secret) {
    throw new Error('WHCC_CONSUMER_KEY and WHCC_CONSUMER_SECRET must be set');
  }

  const params = new URLSearchParams({
    grant_type: 'consumer_credentials',
    consumer_key: key,
    consumer_secret: secret
  });

  const res = await fetch(`${API_URL()}/api/AccessToken?${params}`);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WHCC auth failed (${res.status}): ${body}`);
  }

  const data = await res.json();

  if (data.ErrorNumber) {
    throw new Error(`WHCC auth error ${data.ErrorNumber}: ${data.Message}`);
  }

  const token = data.Token;
  if (!token) {
    throw new Error(`WHCC auth: unexpected response format: ${JSON.stringify(data).substring(0, 200)}`);
  }

  tokenCache = {
    token,
    expiresAt: Date.now() + 55 * 60 * 1000
  };

  return tokenCache.token;
}

/**
 * Make an authenticated request to the WHCC Order API.
 */
async function apiRequest(method, path, body = null) {
  const token = await getAccessToken();
  const url = `${API_URL()}${path}`;

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const text = await res.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const err = new Error(`WHCC API ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }

  return parsed;
}

/**
 * Fetch the full WHCC product catalog.
 */
async function fetchCatalog() {
  return apiRequest('GET', '/api/catalog');
}

/**
 * Import an order into WHCC (creates it but doesn't submit).
 * Returns the ConfirmationID needed for submission.
 */
async function importOrder(payload) {
  return apiRequest('POST', '/api/OrderImport', payload);
}

/**
 * Submit a previously imported order for production.
 */
async function submitOrder(confirmationId) {
  return apiRequest('POST', `/api/OrderImport/Submit/${confirmationId}`);
}

/**
 * Register a webhook callback URL with WHCC.
 */
async function registerWebhook(callbackUri) {
  return apiRequest('POST', '/api/callback/create', { callbackUri });
}

/**
 * Verify a webhook registration with the code WHCC sends.
 */
async function verifyWebhook(verifier) {
  return apiRequest('POST', '/api/callback/verify', { verifier });
}

/**
 * Compute MD5 hash for an image file (used as WHCC image hash).
 */
function computeImageHash(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

/**
 * Build the full image URL WHCC will fetch from us.
 */
function buildImageUrl(relativePath) {
  return `${BASE_URL()}/uploads/${relativePath}`;
}

// Default framed print attributes (validated against WHCC sandbox)
const DEFAULT_FRAME_ATTRIBUTES = {
  orderAttributes: [
    96,    // Drop Ship to Client
    100    // USA Trackable 3 days or less
  ],
  itemAttributes: [
    623,   // Standard Framed Print Mounting
    602,   // Lexington Black Frame
    560,   // Mat
    615,   // Double White Mat
    2495,  // 1" Mat
    617,   // Lustre Photo Print
    627,   // Lustre Coating (Kodak Lustre)
    1878,  // Standard Acrylic
    1907   // Wire Wall Hanger with Paper Backing
  ]
};

/**
 * High-level: place an order with WHCC from our order data.
 * Reads our order -> builds WHCC payload -> import -> submit -> track.
 */
async function placeOrder(orderId, db) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new Error(`Order ${orderId} not found`);

  const shipping = order.shipping_json ? JSON.parse(order.shipping_json) : null;
  if (!shipping) throw new Error(`Order ${orderId} has no shipping address`);

  const photos = order.photos_json ? JSON.parse(order.photos_json) : {};
  const sku = order.product_sku;

  // Look up WHCC product mapping
  const catalog = require('./whccCatalog');
  const mapping = catalog.getProductMapping(sku, db);
  if (!mapping) throw new Error(`No WHCC mapping for SKU: ${sku}`);

  // Find the primary image
  const primaryPhoto = Object.values(photos).find(p => p.originalPath) || Object.values(photos)[0];
  if (!primaryPhoto) throw new Error(`Order ${orderId} has no photos`);

  const imageUrl = buildImageUrl(primaryPhoto.originalPath);
  const entryId = uuidv4();

  // Use custom attributes from mapping, or fall back to defaults
  const itemAttrs = (mapping.whcc_attribute_uids && mapping.whcc_attribute_uids.length > 0)
    ? mapping.whcc_attribute_uids
    : DEFAULT_FRAME_ATTRIBUTES.itemAttributes;

  // Build WHCC order payload (validated against sandbox)
  const payload = {
    EntryId: entryId,
    Orders: [{
      SequenceNumber: 1,
      ShipToAddress: {
        Name: shipping.name || '',
        Addr1: shipping.address1 || shipping.street || '',
        Addr2: shipping.address2 || '',
        City: shipping.city || '',
        State: shipping.state || '',
        Zip: shipping.zip || shipping.postalCode || '',
        Country: shipping.country || 'US'
      },
      ShipFromAddress: {
        Name: 'Still Beside Me',
        Addr1: '3412 S 300 E',
        City: 'Salt Lake City',
        State: 'UT',
        Zip: '84115',
        Country: 'US'
      },
      OrderAttributes: DEFAULT_FRAME_ATTRIBUTES.orderAttributes.map(uid => ({ AttributeUID: uid })),
      OrderItems: [{
        ProductUID: Number(mapping.whcc_product_uid),
        Quantity: 1,
        ItemAssets: [{
          ProductNodeID: 10000,
          AssetPath: imageUrl,
          ImageHash: primaryPhoto.md5 || '',
          AutoRotate: true
        }],
        ItemAttributes: itemAttrs.map(uid => ({ AttributeUID: Number(uid) }))
      }]
    }]
  };

  // Track in our database
  db.run(
    `INSERT INTO whcc_orders (order_id, entry_id, status, request_json)
     VALUES (?, ?, 'pending', ?)`,
    [orderId, entryId, JSON.stringify(payload)]
  );

  // Import to WHCC
  const importResult = await importOrder(payload);
  const confirmationId = importResult.ConfirmationID || importResult.ConfirmationId;

  if (!confirmationId) {
    const errMsg = importResult.Message || JSON.stringify(importResult);
    db.run(
      `UPDATE whcc_orders SET status = 'error', error_message = ?,
       response_json = ?, updated_at = datetime('now') WHERE entry_id = ?`,
      [errMsg, JSON.stringify(importResult), entryId]
    );
    throw new Error(`WHCC import failed: ${errMsg}`);
  }

  db.run(
    `UPDATE whcc_orders SET confirmation_id = ?, status = 'imported',
     response_json = ?, updated_at = datetime('now')
     WHERE entry_id = ?`,
    [String(confirmationId), JSON.stringify(importResult), entryId]
  );

  // Submit for production
  const submitResult = await submitOrder(confirmationId);

  db.run(
    `UPDATE whcc_orders SET status = 'submitted', updated_at = datetime('now')
     WHERE entry_id = ?`,
    [entryId]
  );

  // Log the event
  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [orderId, 'whcc_submitted', JSON.stringify({ entryId, confirmationId, submitResult })]
  );

  // Update main order status
  db.run(
    `UPDATE orders SET status = 'in_production', updated_at = datetime('now') WHERE id = ?`,
    [orderId]
  );

  return { entryId, confirmationId, importResult, submitResult };
}

module.exports = {
  getAccessToken,
  fetchCatalog,
  importOrder,
  submitOrder,
  registerWebhook,
  verifyWebhook,
  computeImageHash,
  buildImageUrl,
  placeOrder
};
