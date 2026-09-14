/**
 * Etsy Open API v3 client. This is the credential layer for the Etsy channel.
 *
 * Every other printer and payment integration in this system authenticates with
 * a static key pair out of the environment. Etsy does not work that way, and the
 * difference is the whole reason this file is careful rather than short.
 *
 * Etsy hands out an access token that lives one hour and a refresh token that
 * lives ninety days. The refresh grant is SINGLE USE: spending a refresh token
 * for a fresh hour of access retires that token and returns a different one. Two
 * things follow, and both of them can take the shop offline.
 *
 * First, the replacement must be written down before anybody gets to use the new
 * access token. If the process dies after Etsy has retired the old token and
 * before we have saved the new one, the grant is simply gone and a human has to
 * click Connect again. So every rotation goes through etsySettings.setJson, which
 * is one statement, and it happens before this module returns anything.
 *
 * Second, two refreshes must never run at once. Two callers presenting the same
 * refresh token is invalid_grant, and invalid_grant here means a locked out shop,
 * not a retryable blip. That is what the in-flight promise below is for. Caching
 * the resulting token is not enough on its own, because the dangerous window is
 * the one where there is no token yet and several requests want one. Concurrent
 * callers must await the SAME promise. If you change one line in this file,
 * please do not let it be that one.
 *
 * There are no retries anywhere in here, deliberately and in line with the rest
 * of the codebase. A failed refresh is not a network hiccup to paper over, it is
 * a fact about the credential, and the honest response is to say "reconnect
 * required" loudly enough that somebody fixes it.
 *
 * Tokens are never logged, never returned in an error message, and never put in
 * an admin alert. The access token string carries the Etsy user id as a prefix,
 * so even a truncated token is worth nothing to us and everything to somebody
 * else. Log the receipt id or the shop id instead.
 *
 * Header format note, unresolved at the time of writing: Etsy's own quickstart
 * shows x-api-key as "keystring:shared_secret", while this project's earlier
 * notes say the keystring alone is accepted. We send the keystring alone unless
 * ETSY_SHARED_SECRET is set, in which case we send the pair. ping() exists so a
 * human can settle the question in thirty seconds, before any OAuth exists.
 */

const crypto = require('crypto');
const etsySettings = require('./etsySettings');

const API_BASE = 'https://api.etsy.com';
const CONNECT_URL = 'https://www.etsy.com/oauth/connect';
const TOKEN_URL = `${API_BASE}/v3/public/oauth/token`;

const KEYSTRING = () => process.env.ETSY_KEYSTRING;
const SHARED_SECRET = () => process.env.ETSY_SHARED_SECRET;

/**
 * transactions_r to read paid receipts, transactions_w to post tracking back.
 * The scope string is part of the authorize URL and part of what Etsy stamps on
 * the grant, so widening it later means every shop has to reconnect.
 */
const ETSY_SCOPES = 'transactions_r transactions_w';

// Access tokens last an hour. We hold one for 55 minutes so an in-flight request
// never gets to use a token that expires mid-call. Same shape as the WHCC client.
let tokenCache = { token: null, expiresAt: 0 };

// The in-flight refresh. See the header comment: this, not tokenCache, is what
// stops two callers from spending the same single-use refresh token.
let refreshInFlight = null;

// Bumped by disconnect(). A refresh takes a second or two, and in that second
// the owner can click Disconnect. Without this, the refresh would finish and
// helpfully write a working credential back into the row we just deleted, so the
// shop would still be connected and the admin page would still say it was not.
// A disconnect has to stick.
let credentialGeneration = 0;

/**
 * True when ETSY_KEYSTRING is really set, using the same placeholder rules as
 * server.js logReadiness(), so a .env copied from the example does not read as
 * configured and send us into an OAuth dance that cannot possibly work.
 */
function isConfigured() {
  const v = KEYSTRING();
  if (!v || !String(v).trim()) return false;
  return !/^(your-|your_|change-me|changeme|placeholder)/i.test(String(v).trim());
}

/** True when a refresh token is on file, which is what "connected" means here. */
function isConnected(db) {
  const stored = etsySettings.getJson(db, 'etsy.oauth');
  return !!(stored && stored.refreshToken);
}

/**
 * PKCE verifier. 32 random bytes base64url encoded is 43 characters drawn from
 * [A-Za-z0-9_-], which sits inside Etsy's legal 43 to 128 range and inside the
 * legal alphabet, so there is nothing to sanitise afterwards.
 */
function makeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

/** PKCE challenge: base64url(sha256(verifier)), unpadded. base64url gives that. */
function challengeFor(verifier) {
  return crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** CSRF state for the authorize round trip. Same alphabet, same reasoning. */
function makeState() {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Build the URL we send the shop owner to. The redirect URI must match what is
 * registered on the Etsy app exactly, character for character, or Etsy refuses
 * before the owner ever sees a consent screen.
 */
function buildAuthUrl({ redirectUri, state, codeChallenge }) {
  if (!isConfigured()) {
    throw new Error('ETSY_KEYSTRING is not set, so there is no Etsy app to authorize against.');
  }
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: KEYSTRING(),
    redirect_uri: redirectUri,
    scope: ETSY_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  // URLSearchParams spells a space as '+', which only means a space to a form
  // decoder. Under plain query rules a '+' is a literal plus, so Etsy could read
  // the scope as one invented permission named "transactions_r+transactions_w".
  // That failure would not show up at consent time; it would surface later as a
  // 403 on every receipt read. %20 is accepted everywhere '+' is.
  return `${CONNECT_URL}?${params.toString().replace(/\+/g, '%20')}`;
}

/**
 * The x-api-key value. Keystring alone, or "keystring:shared_secret" when a
 * shared secret is configured. Both spellings are documented in .env.example.
 */
function apiKeyHeader() {
  const key = KEYSTRING();
  const secret = SHARED_SECRET();
  return secret && String(secret).trim() ? `${key}:${String(secret).trim()}` : key;
}

/**
 * POST to the token endpoint. Used by both grants.
 *
 * The response is read as text first and parsed after, the way every other API
 * client in this codebase does it, because an error page from a proxy is not
 * JSON and losing the body to a parse error is how you end up debugging blind.
 * The thrown error deliberately names the grant type and nothing else: the
 * payload contains a refresh token and must never reach a log line.
 */
async function tokenRequest(payload) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKeyHeader(),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const err = new Error(`Etsy token request (${payload.grant_type}) failed (${res.status})`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }

  if (!parsed || typeof parsed !== 'object' || !parsed.access_token || !parsed.refresh_token) {
    const err = new Error(`Etsy token request (${payload.grant_type}) returned no usable token`);
    err.status = res.status;
    throw err;
  }

  return parsed;
}

/**
 * The Etsy user id is the part of the access token before the first dot. It is
 * the only piece of a token we are ever allowed to keep, and we keep it so a
 * human can tell which Etsy account a stored grant belongs to without having to
 * spend the grant to find out.
 */
function userIdFromToken(accessToken) {
  const dot = String(accessToken).indexOf('.');
  return dot > 0 ? String(accessToken).slice(0, dot) : null;
}

/**
 * Save the rotated refresh token and cache the access token.
 *
 * Order matters and is the point of the function. The write happens first, so
 * the worst case for a crash here is that we hold a saved credential we have not
 * used yet, rather than a used credential we never saved.
 */
function storeGrant(db, data) {
  const tokenUserId = userIdFromToken(data.access_token);

  etsySettings.setJson(db, 'etsy.oauth', {
    refreshToken: data.refresh_token,
    rotatedAt: new Date().toISOString(),
    tokenUserId,
  });

  const lifetime = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  const ttlSeconds = Math.max(60, Math.min(lifetime, 3600) - 300);
  tokenCache = { token: data.access_token, expiresAt: Date.now() + ttlSeconds * 1000 };

  return { tokenUserId };
}

/**
 * Trade the one-time authorization code for a grant. Called once, from the
 * OAuth callback route, with the verifier the session has been holding.
 */
async function exchangeCode(db, { code, redirectUri, codeVerifier }) {
  const data = await tokenRequest({
    grant_type: 'authorization_code',
    client_id: KEYSTRING(),
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier,
  });

  const { tokenUserId } = storeGrant(db, data);
  console.log(`[etsy] connected, Etsy user ${tokenUserId || 'unknown'}`);
  return { tokenUserId };
}

/**
 * Spend the stored refresh token for a new hour of access, and save the
 * replacement Etsy hands back. Never call this directly: go through
 * getAccessToken, which is what serialises it.
 */
async function refreshAccessToken(db) {
  const generation = credentialGeneration;
  const stored = etsySettings.getJson(db, 'etsy.oauth');
  if (!stored || !stored.refreshToken) {
    const err = new Error('Etsy is not connected. Open the admin Etsy page and click Connect.');
    err.code = 'ETSY_REAUTH_REQUIRED';
    throw err;
  }

  let data;
  try {
    data = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: KEYSTRING(),
      refresh_token: stored.refreshToken,
    });
  } catch (err) {
    // The cached token, if there is one, was minted from a grant Etsy has just
    // told us it does not like. Drop it rather than serve it for another minute.
    tokenCache = { token: null, expiresAt: 0 };

    // 400 and 401 from the token endpoint mean the grant itself is finished:
    // expired past ninety days, revoked in the shop's settings, or already spent
    // by something else. No amount of waiting fixes any of those. Anything else
    // (a 500, a timeout) is Etsy having a bad minute and the stored token is
    // probably still good, so we do not cry reconnect over it.
    if (err.status === 400 || err.status === 401) {
      err.code = 'ETSY_REAUTH_REQUIRED';
      console.error(`[etsy] refresh rejected (${err.status}); the Etsy grant is dead and the shop must be reconnected`);
    } else {
      console.error(`[etsy] refresh failed (${err.status || 'no response'}): ${err.message}`);
    }
    throw err;
  }

  // Note what we do NOT do on the reconnect-required path: we leave the stored
  // row alone. It carries rotatedAt and the Etsy user id, which is exactly what
  // a human needs to work out whether this was the ninety day expiry or somebody
  // revoking access, and the reconnect flow overwrites it anyway.

  // Somebody disconnected while this was in the air. Throw the rotated
  // credential away rather than undo their decision. The old token is already
  // spent, which is exactly what disconnect wanted.
  if (generation !== credentialGeneration) {
    const err = new Error('Etsy was disconnected while a token refresh was still running, so the new credential was discarded.');
    err.code = 'ETSY_REAUTH_REQUIRED';
    throw err;
  }

  storeGrant(db, data);
  console.log('[etsy] access token refreshed and the rotated refresh token saved');
  return tokenCache.token;
}

/**
 * A valid access token, minting one if the cached token is gone or stale.
 *
 * Single flight. The first caller starts the refresh and every caller that
 * arrives while it is running awaits the same promise, so the single-use refresh
 * token is presented exactly once. This is the most important behaviour in the
 * file: without it, a page that fires two Etsy requests at the same time can
 * disconnect the shop.
 */
async function getAccessToken(db) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = refreshAccessToken(db).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

/**
 * An authenticated call to the Etsy API. `path` starts '/v3/application/...'.
 *
 * The 20 second timeout matters more here than it looks: sql.js is a single
 * in-memory writer and this process serves the storefront, so a request left
 * hanging on Etsy is a request holding the whole shop's attention.
 */
async function apiRequest(db, method, path, { query, body } = {}) {
  const token = await getAccessToken(db);

  let url = `${API_BASE}${path}`;
  if (query && typeof query === 'object') {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.append(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers = {
    'x-api-key': apiKeyHeader(),
    'Authorization': `Bearer ${token}`,
  };
  if (body) headers['Content-Type'] = 'application/json';

  const options = { method, headers, signal: AbortSignal.timeout(20000) };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(url, options);
  const text = await res.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    // The message carries the path, never the URL: the query string is harmless
    // but the header was not, and keeping the habit is cheaper than auditing it.
    const err = new Error(`Etsy API ${method} ${path} failed (${res.status})`);
    err.status = res.status;
    err.body = parsed;
    if (res.status === 401) {
      // Drop the cached token as well as flagging it. Etsy can reject a token we
      // still think is fresh (the app's access was re-granted, the token was
      // invalidated server side, our clock is optimistic). Without this the same
      // dead string is re-presented for the rest of the 55 minute window and the
      // owner is told to spend a perfectly good 90 day grant. Clearing it means
      // the next call mints one more token and either recovers or fails honestly.
      tokenCache = { token: null, expiresAt: 0 };
      err.code = 'ETSY_REAUTH_REQUIRED';
    }
    throw err;
  }

  return parsed;
}

/**
 * GET /v3/application/openapi-ping. No OAuth, no database, x-api-key only.
 *
 * This exists so a human can answer the one open question about the app
 * credentials (keystring alone, or keystring:shared_secret) before building an
 * authorize URL. A 200 with an application_id means the header format is right.
 */
async function ping() {
  if (!isConfigured()) {
    throw new Error('ETSY_KEYSTRING is not set, so there is nothing to ping with.');
  }

  const res = await fetch(`${API_BASE}/v3/application/openapi-ping`, {
    method: 'GET',
    headers: { 'x-api-key': apiKeyHeader() },
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const err = new Error(`Etsy API GET /v3/application/openapi-ping failed (${res.status})`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }

  return parsed;
}

/**
 * Find and remember which shop this grant belongs to.
 *
 * Every receipt endpoint is addressed by shop id, and the shop id is not in the
 * token, so it has to be looked up once and kept. Stored under 'etsy.shop' with
 * the shop name, because a human reading the admin page needs to see the name of
 * a shop, not a nine digit number they cannot verify.
 */
async function discoverShopId(db) {
  const me = await apiRequest(db, 'GET', '/v3/application/users/me');
  const shopId = me && me.shop_id;

  if (!shopId) {
    throw new Error(
      'Etsy says this account has no shop. The most likely cause is that the authorization was '
      + 'granted by a personal buyer account rather than the account that owns the shop. '
      + 'Disconnect, sign in to Etsy as the shop owner, and connect again.'
    );
  }

  let shopName = null;
  try {
    const shop = await apiRequest(db, 'GET', `/v3/application/shops/${shopId}`);
    shopName = (shop && shop.shop_name) || null;
  } catch (err) {
    // The name is a nicety. Losing it must not cost us the id, which is the
    // thing every later call actually needs.
    console.warn(`[etsy] shop ${shopId} name lookup failed (${err.status || 'no response'}); saving the id without it`);
  }

  etsySettings.setJson(db, 'etsy.shop', {
    shopId,
    shopName,
    connectedAt: new Date().toISOString(),
  });
  console.log(`[etsy] shop ${shopId} (${shopName || 'name unknown'}) saved`);

  return { shopId, shopName };
}

/** The stored shop id, discovering it once if this is the first call. */
async function requireShopId(db) {
  const stored = etsySettings.getJson(db, 'etsy.shop');
  if (stored && stored.shopId) return stored.shopId;
  const { shopId } = await discoverShopId(db);
  return shopId;
}

/**
 * The paid, unshipped, uncancelled receipts, newest first.
 *
 * The three filters are fixed on purpose. A receipt that is not paid is not an
 * order, one that is shipped is already done, and one that is cancelled must
 * never reach a printer.
 *
 * minCreated is off by default and should stay that way for the routine pull.
 * It is tempting to feed it the "last pull" watermark, and that is a trap: a
 * receipt that failed to ingest on the pull that saw it would then sit outside
 * the window forever and never be retried, and nobody would find out until a
 * buyer asked where their order was. The UNIQUE index on orders.etsy_receipt_id
 * is the only deduplication that is allowed to matter. The parameter is here for
 * a deliberate backfill, where a human picks the date.
 */
async function getShopReceipts(db, { limit = 25, offset = 0, minCreated } = {}) {
  const shopId = await requireShopId(db);
  return apiRequest(db, 'GET', `/v3/application/shops/${shopId}/receipts`, {
    query: {
      was_paid: 'true',
      was_shipped: 'false',
      was_canceled: 'false',
      sort_on: 'created',
      sort_order: 'descending',
      limit,
      offset,
      min_created: minCreated,
    },
  });
}

/** One receipt, by id. Used when re-reading a single order for the review page. */
async function getShopReceipt(db, receiptId) {
  const shopId = await requireShopId(db);
  return apiRequest(db, 'GET', `/v3/application/shops/${shopId}/receipts/${receiptId}`);
}

/**
 * Tell Etsy an order has shipped, which marks it complete and emails the buyer
 * their tracking number.
 *
 * NOT DEAD CODE. Nothing calls this yet by design: the printer hands back
 * tracking days after ingest, and the round that wires Luma's shipment webhook
 * to Etsy is scheduled after this one. Leave it here. Writing it now, next to
 * the auth it depends on, is why transactions_w is in the scope string, and
 * adding a scope later means every shop has to reconnect.
 *
 * If Etsy rejects the JSON body, the other spelling this endpoint is documented
 * with is form encoding. Try that before suspecting the auth.
 */
async function createReceiptShipment(db, receiptId, { trackingCode, carrierName }) {
  const shopId = await requireShopId(db);
  const result = await apiRequest(
    db,
    'POST',
    `/v3/application/shops/${shopId}/receipts/${receiptId}/tracking`,
    { body: { tracking_code: trackingCode, carrier_name: carrierName } }
  );
  console.log(`[etsy] receipt ${receiptId} marked shipped with ${carrierName}`);
  return result;
}

/**
 * Forget the shop.
 *
 * The stored rows go and so does the cached access token, because a cached token
 * outliving a disconnect would let the next request keep working for up to an
 * hour and make the admin page a liar. Etsy has no revoke endpoint worth calling
 * here, so the owner removing the app in their Etsy settings is the other half.
 */
function disconnect(db) {
  credentialGeneration++;
  etsySettings.remove(db, 'etsy.oauth');
  etsySettings.remove(db, 'etsy.shop');
  // 'etsy.meta' deliberately survives. It holds lastReceiptSample, the first
  // real Etsy receipt this system ever sees, which is the test fixture nobody
  // can write until a sale happens. Disconnect is the routine way back from an
  // expired grant, so wiping the evidence on the recovery path would throw away
  // the one thing that cannot be recreated. Forget the permission, keep the
  // record of what happened.
  const meta = etsySettings.getJson(db, 'etsy.meta');
  if (meta && meta.lastPullAt) {
    etsySettings.setJson(db, 'etsy.meta', { ...meta, lastPullAt: null });
  }
  tokenCache = { token: null, expiresAt: 0 };
  console.log('[etsy] disconnected, stored credentials removed');
}

module.exports = {
  ETSY_SCOPES,
  isConfigured,
  isConnected,
  makeVerifier,
  challengeFor,
  makeState,
  buildAuthUrl,
  exchangeCode,
  getAccessToken,
  apiRequest,
  ping,
  discoverShopId,
  getShopReceipts,
  getShopReceipt,
  createReceiptShipment,
  disconnect,
};
