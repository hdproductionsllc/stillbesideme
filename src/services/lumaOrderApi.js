/**
 * Luma Prints API Client
 * Handles authentication, order placement, shipment tracking, and product discovery.
 * Docs: https://us.api.lumaprints.com (HTTP Basic auth)
 */

const API_URL = () => {
  const env = process.env.LUMA_ENVIRONMENT || 'sandbox';
  return env === 'production'
    ? 'https://us.api.lumaprints.com'
    : 'https://us.api-sandbox.lumaprints.com';
};

const BASE_URL = () => process.env.BASE_URL || 'http://localhost:3001';

/**
 * Luma product configuration.
 * Discovered via GET /api/luma/setup on 2026-02-21.
 *
 * Key insight: Luma bakes frame color into the subcategory.
 * Each subcategory IS a specific frame profile + color.
 * Options (mat, paper, glazing, etc.) are shared across all subcategories.
 */
const LUMA_CONFIG = {
  // Still Beside Me store (discovered via GET /api/v1/stores)
  storeId: process.env.LUMA_STORE_ID ? Number(process.env.LUMA_STORE_ID) : 81799,

  // Subcategory = frame color. Using 1.25" profile (supports 5" to 60x40).
  // Our style variants map to these subcategories:
  subcategories: {
    'classic-dark': 105005,  // 1.25w x 0.875h Black Frame
    'warm-natural': 105007,  // 1.25w x 0.875h Oak Frame
    'soft-light':   105006,  // 1.25w x 0.875h White Frame
  },

  // Mat color per style variant (matches what the customer sees in the preview)
  matColors: {
    'classic-dark': 98,   // Smooth Black (preview: #1a1a1a)
    'warm-natural': 102,  // Cream (preview: #F5EDE0)
    'soft-light':   96,   // White (preview: #FFFFFF)
  },

  // Options shared across all styles (one per option group, excludes mat color)
  sharedOptions: [
    65,   // Mat Size: 1.0 inch on each side
    78,   // Paper Type: Semi-Glossy Photo Paper
    146,  // Glazing: Acrylic Glass
    83,   // Hanging Hardware: Hanging Wire
    95,   // Backing: Kraft Paper
    148,  // Print Mounting: Dry Mounted to Foam Core
  ],
};

/**
 * Build Basic auth header from API key + secret.
 */
function getAuthHeader() {
  const key = process.env.LUMA_API_KEY;
  const secret = process.env.LUMA_API_SECRET;
  if (!key || !secret) {
    throw new Error('LUMA_API_KEY and LUMA_API_SECRET must be set');
  }
  const encoded = Buffer.from(`${key}:${secret}`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Make an authenticated request to the Luma API.
 */
async function apiRequest(method, path, body = null) {
  const url = `${API_URL()}${path}`;

  const options = {
    method,
    headers: {
      'Authorization': getAuthHeader(),
      'Content-Type': 'application/json',
    },
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
    const err = new Error(`Luma API ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }

  return parsed;
}

/**
 * GET /api/v1/stores - List stores linked to this account.
 */
async function getStores() {
  return apiRequest('GET', '/api/v1/stores');
}

/**
 * GET /api/v1/products/categories - List all product categories.
 */
async function getCategories() {
  return apiRequest('GET', '/api/v1/products/categories');
}

/**
 * GET /api/v1/products/subcategories/:id/options - List options for a subcategory.
 */
async function getSubcategoryOptions(subcategoryId) {
  return apiRequest('GET', `/api/v1/products/subcategories/${subcategoryId}/options`);
}

/**
 * POST /api/v1/orders - Create a new order.
 */
async function createOrder(payload) {
  return apiRequest('POST', '/api/v1/orders', payload);
}

/**
 * GET /api/v1/orders/:orderNumber - Get order details.
 */
async function getOrder(orderNumber) {
  return apiRequest('GET', `/api/v1/orders/${orderNumber}`);
}

/**
 * GET /api/v1/shipments/:orderNumber - Get shipment tracking info.
 */
async function getShipments(orderNumber) {
  return apiRequest('GET', `/api/v1/shipments/${orderNumber}`);
}

/**
 * POST /api/v1/webhook - Subscribe to webhook events.
 */
async function subscribeWebhook(storeId, callbackUrl) {
  return apiRequest('POST', '/api/v1/webhook', {
    storeId,
    event: 'shipping',
    callbackUrl,
  });
}

/**
 * Build the public URL for an uploaded image.
 */
function buildImageUrl(relativePath) {
  return `${BASE_URL()}/uploads/${relativePath}`;
}

/**
 * Parse print dimensions from SKU (e.g., "framed-11x14" -> { width: 11, height: 14 }).
 */
function parseSizeFromSku(sku) {
  const match = sku.match(/(\d+)x(\d+)/);
  if (!match) throw new Error(`Cannot parse size from SKU: ${sku}`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

/**
 * Build order item options for a style variant.
 * Combines shared options with the style-specific mat color.
 */
function buildOrderItemOptions(styleVariant) {
  const matColorId = LUMA_CONFIG.matColors[styleVariant] || LUMA_CONFIG.matColors['classic-dark'];
  return [...LUMA_CONFIG.sharedOptions, matColorId].map(id => ({ optionId: id }));
}

/**
 * Resolve the Luma subcategoryId for a style variant.
 * Frame color is determined by subcategory, not by an option.
 */
function resolveSubcategoryId(styleVariant) {
  const subId = LUMA_CONFIG.subcategories[styleVariant];
  if (!subId) {
    // Fall back to classic-dark (Black frame)
    return LUMA_CONFIG.subcategories['classic-dark'];
  }
  return subId;
}

/**
 * High-level: place an order with Luma from our order data.
 * Mirrors whccOrderApi.placeOrder() flow.
 */
async function placeOrder(orderId, db) {
  const order = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!order) throw new Error(`Order ${orderId} not found`);

  const shipping = order.shipping_json ? JSON.parse(order.shipping_json) : null;
  if (!shipping) throw new Error(`Order ${orderId} has no shipping address`);

  const photos = order.photos_json ? JSON.parse(order.photos_json) : {};
  const sku = order.product_sku;
  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};

  // Parse dimensions from SKU
  const { width, height } = parseSizeFromSku(sku);

  // Find the primary image (composite/print-ready file)
  const primaryPhoto = Object.values(photos).find(p => p.originalPath) || Object.values(photos)[0];
  if (!primaryPhoto) throw new Error(`Order ${orderId} has no photos`);
  const imageUrl = buildImageUrl(primaryPhoto.originalPath);

  // Resolve storeId
  const storeId = LUMA_CONFIG.storeId;
  if (!storeId) throw new Error('LUMA_STORE_ID not configured. Run GET /api/luma/setup first.');

  // Split shipping name into first/last
  const nameParts = (shipping.name || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Resolve frame color via subcategory (Luma bakes frame into subcategory)
  const styleVariant = fields.styleVariant || 'classic-dark';
  const subcategoryId = resolveSubcategoryId(styleVariant);

  // Build Luma order payload
  const payload = {
    externalId: orderId,
    storeId,
    shippingMethod: 'default',
    productionTime: 'regular',
    recipient: {
      firstName,
      lastName,
      addressLine1: shipping.address1 || '',
      addressLine2: shipping.address2 || '',
      city: shipping.city || '',
      state: shipping.state || '',
      zipCode: shipping.zip || '',
      country: shipping.country || 'US',
    },
    orderItems: [{
      externalItemId: `${orderId}-1`,
      subcategoryId,
      quantity: 1,
      width,
      height,
      file: {
        imageUrl,
      },
      orderItemOptions: buildOrderItemOptions(styleVariant),
    }],
  };

  // Insert tracking row
  db.run(
    `INSERT INTO luma_orders (order_id, status, request_json)
     VALUES (?, 'pending', ?)`,
    [orderId, JSON.stringify(payload)]
  );

  // Submit to Luma
  const result = await createOrder(payload);
  const orderNumber = result.orderNumber || result.OrderNumber;

  if (!orderNumber) {
    const errMsg = result.message || JSON.stringify(result);
    db.run(
      `UPDATE luma_orders SET status = 'error', error_message = ?,
       response_json = ?, updated_at = datetime('now')
       WHERE order_id = ? AND status = 'pending'`,
      [errMsg, JSON.stringify(result), orderId]
    );
    throw new Error(`Luma order creation failed: ${errMsg}`);
  }

  // Update tracking with Luma's order number
  db.run(
    `UPDATE luma_orders SET luma_order_number = ?, status = 'submitted',
     response_json = ?, updated_at = datetime('now')
     WHERE order_id = ? AND status = 'pending'`,
    [String(orderNumber), JSON.stringify(result), orderId]
  );

  // Log event
  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [orderId, 'luma_submitted', JSON.stringify({ orderNumber })]
  );

  // Update main order status
  db.run(
    `UPDATE orders SET status = 'in_production', fulfillment_provider = 'luma',
     updated_at = datetime('now') WHERE id = ?`,
    [orderId]
  );

  return { orderNumber };
}

module.exports = {
  apiRequest,
  getStores,
  getCategories,
  getSubcategoryOptions,
  createOrder,
  getOrder,
  getShipments,
  subscribeWebhook,
  buildImageUrl,
  placeOrder,
  LUMA_CONFIG,
};
