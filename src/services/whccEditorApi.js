/**
 * WHCC Editor API Client
 * White-label design editor integration for comparison testing.
 * Docs: https://developer.whcc.com/editor-api
 */

const API_URL = () => process.env.WHCC_EDITOR_API_URL || 'https://prospector-stage.dragdrop.design';
const KEY_ID = () => process.env.WHCC_EDITOR_KEY_ID;
const KEY_SECRET = () => process.env.WHCC_EDITOR_KEY_SECRET;

// In-memory token cache (85-minute TTL, tokens last 90 min)
let tokenCache = { token: null, expiresAt: 0 };

/**
 * Get a JWT access token for the Editor API.
 */
async function getEditorToken(accountId = 'stillbesideme') {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const keyId = KEY_ID();
  const keySecret = KEY_SECRET();
  if (!keyId || !keySecret) {
    throw new Error('WHCC_EDITOR_KEY_ID and WHCC_EDITOR_KEY_SECRET must be set');
  }

  const res = await fetch(`${API_URL()}/api/v1/auth/access-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      keyId,
      keySecret,
      accountId
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WHCC Editor auth failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  const token = data.token || data.accessToken || data;

  tokenCache = {
    token,
    expiresAt: Date.now() + 85 * 60 * 1000
  };

  return token;
}

/**
 * Make an authenticated request to the WHCC Editor API.
 */
async function apiRequest(method, path, body = null) {
  const token = await getEditorToken();
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
    const err = new Error(`WHCC Editor API ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }

  return parsed;
}

/**
 * Fetch available products from the Editor API.
 */
async function getProducts() {
  return apiRequest('GET', '/api/v1/products');
}

/**
 * Fetch available design templates.
 */
async function getDesigns() {
  return apiRequest('GET', '/api/v1/designs');
}

/**
 * Create an editor session. Returns a URL to redirect the user to.
 */
async function createEditor(userId, productId, designId, options = {}) {
  return apiRequest('POST', '/api/v1/editors', {
    userId,
    productId,
    designId,
    ...options
  });
}

/**
 * Export editor data (completed design) for order fulfillment.
 */
async function exportEditor(editorId) {
  return apiRequest('PUT', `/api/v1/oas/editors/export`, {
    editorId
  });
}

/**
 * Create an order from exported editor data.
 */
async function createOrder(orderData) {
  return apiRequest('POST', '/api/v1/oas/orders', orderData);
}

/**
 * Confirm an order for production.
 */
async function confirmOrder(orderId) {
  return apiRequest('POST', `/api/v1/oas/orders/${orderId}/confirm`);
}

/**
 * Fetch the editor product catalog (for caching via whccCatalog).
 */
async function fetchCatalog() {
  return getProducts();
}

module.exports = {
  getEditorToken,
  getProducts,
  getDesigns,
  createEditor,
  exportEditor,
  createOrder,
  confirmOrder,
  fetchCatalog
};
