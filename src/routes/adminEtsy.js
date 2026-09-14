/**
 * The Etsy shop connection, and the button that brings its orders in.
 *
 * GET  /admin/etsy                  the page
 * GET  /admin/api/etsy/status       configured, connected, which shop, last pull
 * GET  /admin/etsy/connect          starts the authorization, server-side redirect
 * GET  /admin/etsy/callback         where Etsy sends the buyer back
 * POST /admin/api/etsy/pull         read receipts, make orders out of them
 * POST /admin/api/etsy/disconnect   forget the grant
 *
 * This is the automatic version of the door adminIntake.js opens by hand. It
 * changes who does the typing and nothing else: an order arrives in
 * awaiting_review exactly as it does from the form, with no poem, no proof and
 * no printer. Every safety rail that mattered when a person was copying the
 * answers across still holds when Etsy hands them over directly, because both
 * routes end in the same orderIntake.createFromMarketplace.
 *
 * Three things here are less obvious than they look.
 *
 * The callback is NOT behind requireAdmin. Etsy's authorization code can be
 * spent once. requireAdmin redirects a lapsed session to /admin/login, and
 * that redirect would swallow the code and leave a human staring at a login
 * form wondering why connecting failed. So the callback checks the one-time
 * grant in the session itself and, whatever happens, renders a page that says
 * in words what went on. It never redirects.
 *
 * Connecting is a server-side res.redirect rather than a form that posts to
 * etsy.com. helmet is configured with its defaults, so CSP form-action stays
 * at 'self' and the browser would silently refuse to submit a cross-origin
 * form. A redirect is not covered by form-action and is also the flow Etsy
 * documents.
 *
 * A pull holds a module-level flag. Two overlapping pulls would both read the
 * same page of receipts and race on the duplicate check, and worse, each would
 * spend a refresh token. One at a time, and the second caller is told so.
 *
 * No token, access or refresh, is ever put in a response or a log line from
 * this file. The status endpoint reports WHEN the credential last rotated and
 * nothing about what it is.
 */

const express = require('express');
const path = require('path');
const router = express.Router();

const { requireAdmin } = require('./adminDashboard');
const etsyApi = require('../services/etsyApi');
const etsyIngest = require('../services/etsyIngest');
const etsySettings = require('../services/etsySettings');

// Etsy's authorization code is short-lived and the verifier beside it is the
// only thing proving this browser started the exchange. Ten minutes is long
// enough to sign in to Etsy and pick the shop, short enough that a forgotten
// tab is not a standing invitation.
const GRANT_TTL_MS = 10 * 60 * 1000;

// A refresh token lasts 90 days. Past that the shop is not connected any more,
// it only looks connected, and the first pull of the day is where that would
// otherwise be discovered.
const REFRESH_TOKEN_LIFE_DAYS = 90;

// How many receipts one press of the button reads. Etsy pages; this shop does
// not do hundreds of orders a day, and a smaller page means a failure costs
// less and the results list stays readable.
const PULL_PAGE_SIZE = 25;

const BASE_URL = () => process.env.BASE_URL || 'http://localhost:3001';

/**
 * The redirect URI, which has to be byte-identical to the one registered in
 * the Etsy developer portal or the exchange fails with a bare error. It is
 * derived from BASE_URL in one place so the authorize link and the token
 * exchange can never disagree, and it is shown on the page so the string a
 * human registers is the string this app actually sends.
 */
function redirectUri() {
  return `${BASE_URL().replace(/\/+$/, '')}/admin/etsy/callback`;
}

/** Only one pull at a time. See the header comment. */
let pullInFlight = false;

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The callback's only output. Every branch of the exchange, success or
 * failure, ends on one of these, because a redirect at that point either
 * loses the reason or burns the code.
 */
function resultPage({ title, heading, body, tone }) {
  const accent = tone === 'bad' ? '#e5a3a3' : tone === 'warn' ? '#C4A882' : '#8B9D83';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title)}</title><style>
:root { --bg:#1a1714; --panel:#26211c; --line:#3a332c; --text:#f4f1ea; --muted:#a89e90; --accent:#C4A882; }
*{box-sizing:border-box} body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);padding:24px}
.card{background:var(--panel);border:1px solid var(--line);border-left:3px solid ${accent};
border-radius:12px;padding:28px 30px;max-width:560px;width:100%}
h1{font-size:1.05rem;margin:0 0 14px;color:${accent}}
p{font-size:.88rem;line-height:1.6;color:var(--muted);margin:0 0 12px}
p strong{color:var(--text);font-weight:600}
code{background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:2px 6px;font-size:.8rem;color:var(--text)}
a{color:var(--accent)}
</style></head><body><div class="card"><h1>${escapeHtml(heading)}</h1>${body}
<p><a href="/admin/etsy">Back to the Etsy page</a></p></div></body></html>`;
}

/** Days since an ISO timestamp, or null if there is not a usable one. */
function daysSince(iso) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return (Date.now() - then) / 86400000;
}

router.get('/etsy', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'etsy.html'));
});

router.get('/api/etsy/status', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  try {
    const oauth = etsySettings.getJson(db, 'etsy.oauth') || {};
    const shop = etsySettings.getJson(db, 'etsy.shop') || {};
    const meta = etsySettings.getJson(db, 'etsy.meta') || {};
    const connected = etsyApi.isConnected(db);
    const age = daysSince(oauth.rotatedAt);

    res.json({
      configured: etsyApi.isConfigured(),
      connected,
      shopId: shop.shopId || null,
      shopName: shop.shopName || null,
      connectedAt: shop.connectedAt || null,
      lastPullAt: meta.lastPullAt || null,
      // rotatedAt, never the token it belongs to.
      tokenRotatedAt: oauth.rotatedAt || null,
      // A stored grant older than Etsy's 90 days will not refresh. Saying so
      // here turns a baffling failed pull into an obvious reconnect.
      reauthRequired: connected && age !== null && age >= REFRESH_TOKEN_LIFE_DAYS,
      redirectUri: redirectUri(),
    });
  } catch (err) {
    console.error('[etsy] status failed:', err.message);
    res.status(500).json({ error: 'Could not read the Etsy connection state.' });
  }
});

/**
 * Ask Etsy whether it recognises the API key, before any of the OAuth dance.
 *
 * There is one genuinely open question about this app's credentials: Etsy's own
 * quickstart shows the x-api-key header as "keystring:shared_secret" while the
 * developer portal hands out a keystring on its own. Getting it wrong does not
 * fail here, where the message would be plain. It fails in the middle of the
 * handshake, as an unexplained token exchange error, after the owner has
 * already approved the app. One button turns that into a yes or a no.
 */
router.get('/api/etsy/ping', requireAdmin, async (req, res) => {
  if (!etsyApi.isConfigured()) {
    return res.status(503).json({ error: 'No API key is set. Add ETSY_KEYSTRING to the environment and restart.' });
  }
  try {
    const result = await etsyApi.ping();
    const withSecret = !!(process.env.ETSY_SHARED_SECRET || '').trim();
    res.json({
      ok: true,
      applicationId: result && result.application_id ? result.application_id : null,
      sentSharedSecret: withSecret,
    });
  } catch (err) {
    // Say what Etsy said. The first version of this guessed at the cause and
    // offered both directions ("set the secret, or clear it"), which buried the
    // one useful sentence Etsy had already handed back: "Shared secret is
    // required in x-api-key header." A vendor that names the problem should be
    // quoted, not paraphrased.
    const fromEtsy = err.body && typeof err.body === 'object' && err.body.error
      ? String(err.body.error)
      : '';
    console.error(`[etsy] ping failed (${err.status || 'no status'}): ${fromEtsy || err.message}`);
    res.status(502).json({
      ok: false,
      error: fromEtsy
        ? `Etsy says: ${fromEtsy}`
        : `Etsy did not answer the key check: ${err.message}`,
    });
  }
});

router.get('/etsy/connect', requireAdmin, (req, res) => {
  if (!etsyApi.isConfigured()) {
    return res.status(503).send(resultPage({
      title: 'Etsy is not configured',
      heading: 'There is no API key set',
      tone: 'bad',
      body: '<p>Set <code>ETSY_KEYSTRING</code> in the environment and restart, then try connecting again.</p>',
    }));
  }

  const verifier = etsyApi.makeVerifier();
  const state = etsyApi.makeState();

  // The verifier never leaves this server. Only its hash goes to Etsy, and
  // only this session can finish the exchange that started here.
  req.session.etsyOauth = { verifier, state, createdAt: Date.now() };

  const url = etsyApi.buildAuthUrl({
    redirectUri: redirectUri(),
    state,
    codeChallenge: etsyApi.challengeFor(verifier),
  });

  // Save before leaving the site. The session store writes to disk, and the
  // browser comes back to the callback on a fresh request: if the write has
  // not landed, the grant is gone and the code cannot be spent.
  req.session.save((err) => {
    if (err) {
      console.error('[etsy] could not save the oauth grant to the session:', err.message);
      return res.status(500).send(resultPage({
        title: 'Could not start',
        heading: 'Could not start connecting',
        tone: 'bad',
        body: '<p>The session would not save, so the connection was not started. Nothing changed. Try again.</p>',
      }));
    }
    res.redirect(url);
  });
});

/**
 * Etsy sends the seller back here. Registered redirect URI, so the path and
 * spelling are load bearing. Deliberately ungated, deliberately never a
 * redirect: see the header comment.
 */
router.get('/etsy/callback', async (req, res) => {
  const db = req.app.locals.db;
  const grant = req.session && req.session.etsyOauth;

  // One use, whatever happens next. A grant left lying in the session is a
  // second chance for somebody else's callback to use it.
  if (req.session && req.session.etsyOauth) delete req.session.etsyOauth;

  const fail = (heading, body) => res.status(400).send(resultPage({
    title: 'Etsy did not connect', heading, body, tone: 'bad',
  }));

  if (req.query.error) {
    console.warn(`[etsy] callback returned an error: ${req.query.error}`);
    return fail('Etsy said no', `<p>Etsy returned <strong>${escapeHtml(req.query.error)}</strong>` +
      (req.query.error_description ? `: ${escapeHtml(req.query.error_description)}` : '') +
      '.</p><p>Nothing was changed. If you declined the permission prompt, start again and accept it.</p>');
  }

  if (!grant || !grant.state || !grant.verifier) {
    return fail('This browser did not start that connection', '<p>The half of the handshake that lives on ' +
      'this server is missing, which usually means the connection was started in another browser, or the ' +
      'session expired, or this link was opened a second time.</p><p>Sign in and press Connect again.</p>');
  }

  if (!grant.createdAt || Date.now() - grant.createdAt > GRANT_TTL_MS) {
    return fail('That took too long', '<p>The connection was started more than ten minutes ago, so it was ' +
      'thrown away. Press Connect again and the whole thing takes about twenty seconds.</p>');
  }

  if (req.query.state !== grant.state) {
    console.warn('[etsy] callback state did not match the stored grant');
    return fail('That did not come back from where it went out', '<p>The state value Etsy returned is not ' +
      'the one this server sent, so the response was ignored. Press Connect again, and if it keeps happening ' +
      'do it from a fresh tab.</p>');
  }

  if (!req.query.code) {
    return fail('Etsy sent no code', '<p>There is no authorization code in the response, so there is nothing ' +
      'to exchange. Press Connect again.</p>');
  }

  let tokenUserId;
  try {
    const exchanged = await etsyApi.exchangeCode(db, {
      code: req.query.code,
      redirectUri: redirectUri(),
      codeVerifier: grant.verifier,
    });
    tokenUserId = exchanged && exchanged.tokenUserId;
  } catch (err) {
    console.error('[etsy] token exchange failed:', err.message);
    return res.status(502).send(resultPage({
      title: 'Etsy did not connect',
      heading: 'The exchange failed',
      tone: 'bad',
      body: `<p>Etsy would not trade the code for a token: <strong>${escapeHtml(err.message)}</strong></p>` +
        `<p>The usual cause is the redirect address. This app sends <code>${escapeHtml(redirectUri())}</code>, ` +
        'and that exact string has to be registered in the Etsy developer portal, character for character.</p>',
    }));
  }

  // From here the shop IS connected. Anything that fails below is worth
  // saying, but it is not worth implying the grant did not save.
  let shopName = null;
  let shopWarning = '';
  try {
    const shop = await etsyApi.discoverShopId(db);
    shopName = shop && shop.shopName;
  } catch (err) {
    console.error('[etsy] could not work out which shop this is:', err.message);
    shopWarning = '<p>The connection saved, but working out which shop it belongs to failed: ' +
      `<strong>${escapeHtml(err.message)}</strong> Open the Etsy page and check the status before pulling orders.</p>`;
  }

  console.log(`[etsy] connected${tokenUserId ? ` as user ${tokenUserId}` : ''}${shopName ? `, shop ${shopName}` : ''}`);

  res.send(resultPage({
    title: 'Etsy connected',
    heading: shopName ? `Connected to ${shopName}` : 'Connected',
    tone: shopWarning ? 'warn' : 'good',
    body: shopWarning ||
      '<p>Orders can be pulled in from here on. Nothing comes in on its own and nothing reaches the printer ' +
      'without your review.</p>',
  }));
});

router.post('/api/etsy/pull', requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const dryRun = !!(req.body && req.body.dryRun);

  if (!etsyApi.isConfigured()) {
    return res.status(503).json({ error: 'Etsy is not configured. Set ETSY_KEYSTRING and restart.' });
  }
  if (!etsyApi.isConnected(db)) {
    return res.status(409).json({ error: 'The shop is not connected yet. Connect it first.' });
  }
  if (pullInFlight) {
    return res.status(409).json({ error: 'A pull is already running. Wait for it to finish rather than starting a second one.' });
  }

  pullInFlight = true;
  const results = [];
  let created = 0, skipped = 0, refused = 0, errored = 0;

  try {
    const page = await etsyApi.getShopReceipts(db, { limit: PULL_PAGE_SIZE });
    const receipts = page && Array.isArray(page.results) ? page.results : [];

    // Sequential on purpose. These share one sql.js writer and one refresh
    // token, and a batch of five is not worth the concurrency bugs.
    for (const receipt of receipts) {
      const receiptId = receipt && receipt.receipt_id;
      try {
        // Cheap local check first, so an order we already have costs no
        // mapping work and no photo download.
        const existing = receiptId != null
          ? db.get('SELECT id, admin_token FROM orders WHERE etsy_receipt_id = ?', [String(receiptId)])
          : null;
        if (existing) {
          skipped++;
          results.push({
            receiptId,
            outcome: 'duplicate',
            reason: 'Already in the system.',
            orderId: existing.id,
            reviewUrl: existing.admin_token ? `/admin/review/${existing.admin_token}` : null,
            warnings: [],
          });
          continue;
        }

        const out = await etsyIngest.ingestReceipt(db, receipt, { dryRun });
        results.push(out);

        if (out.outcome === 'created' || out.outcome === 'would-create') created++;
        else if (out.outcome === 'duplicate') skipped++;
        else if (out.outcome === 'refused') refused++;
        else errored++;
      } catch (err) {
        // One unmappable receipt must never end the batch. The rest of the
        // day's orders are still worth having.
        errored++;
        console.error(`[etsy pull] receipt ${receiptId} failed:`, err.message);
        results.push({
          receiptId,
          outcome: 'error',
          reason: err.message || 'Something went wrong reading that order.',
          orderId: null,
          reviewUrl: null,
          warnings: [],
        });
      }
    }

    // Informational only. Nothing keys off it, so a failed write here must not
    // lose the results of a pull that already happened. A dry run writes
    // nothing at all: checking for orders is not pulling them, and the status
    // panel reads this as "last pull".
    if (!dryRun) {
      try {
        const meta = etsySettings.getJson(db, 'etsy.meta') || {};
        meta.lastPullAt = new Date().toISOString();
        etsySettings.setJson(db, 'etsy.meta', meta);
      } catch (err) {
        console.warn('[etsy pull] could not record the pull time:', err.message);
      }
    }

    console.log(`[etsy pull] ${dryRun ? 'dry run, ' : ''}checked ${receipts.length}, created ${created}, skipped ${skipped}, refused ${refused}, errored ${errored}`);

    res.json({ dryRun, checked: receipts.length, created, skipped, refused, errored, results });
  } catch (err) {
    console.error('[etsy pull] could not read receipts:', err.message);
    // etsyApi flags the one failure a person can actually do something about.
    // Without this branch a revoked permission shows up as a raw 400 from a
    // token endpoint, while the stored row keeps the page saying "Connected"
    // and hides the Connect button, leaving no way forward but guesswork.
    if (err.code === 'ETSY_REAUTH_REQUIRED') {
      return res.status(409).json({
        error: 'Etsy no longer accepts our permission for the shop. Connect it again on this page.',
        reauthRequired: true,
      });
    }
    res.status(502).json({ error: `Could not read orders from Etsy: ${err.message}` });
  } finally {
    pullInFlight = false;
  }
});

router.post('/api/etsy/disconnect', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  try {
    // Through etsyApi, not the settings table, because the access token is
    // also cached in memory and a grant that is gone from the database while
    // a live token lingers is the worst of both.
    etsyApi.disconnect(db);
    console.log('[etsy] disconnected by an admin');
    res.json({ success: true });
  } catch (err) {
    console.error('[etsy] disconnect failed:', err.message);
    res.status(500).json({ error: 'Could not clear the connection.' });
  }
});

module.exports = router;
