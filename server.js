require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');

// Initialize Sentry (error monitoring)
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.1,
  });
}

const app = express();
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const OUTPUT_DIR = process.env.OUTPUT_DIR || path.join(__dirname, 'output');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

// Ensure required directories exist
for (const dir of [DATA_DIR, SESSIONS_DIR, UPLOADS_DIR, OUTPUT_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// --- Digital Keepsake helpers (mirror the loadTemplate pattern in
// checkout.js / adminReview.js — fulfillment lives on the SKU's template entry,
// which is the only trusted source of "is this a digital order").
const TEMPLATES_DIR = path.join(__dirname, 'src', 'data', 'templates');
const _templateCache = {};
function loadTemplate(templateId) {
  if (_templateCache[templateId]) return _templateCache[templateId];
  const fp = path.join(TEMPLATES_DIR, `${templateId}.json`);
  if (!fs.existsSync(fp)) return null;
  _templateCache[templateId] = JSON.parse(fs.readFileSync(fp, 'utf-8'));
  return _templateCache[templateId];
}
function isDigitalOrder(order) {
  const t = loadTemplate(order.template_id);
  if (!t || !Array.isArray(t.printProducts)) return false;
  const p = t.printProducts.find(x => x.sku === order.product_sku);
  return !!p && p.fulfillment === 'digital';
}
/** Build the attachment filename, e.g. "Banjo-tribute-11x14.jpg". */
function downloadFilename(order) {
  const t = loadTemplate(order.template_id);
  const mapping = (t && t.tributeMapping) || {};
  let fields = {};
  try { fields = order.fields_json ? JSON.parse(order.fields_json) : {}; } catch (e) { /* ignore */ }
  const rawName = (mapping.name && fields[mapping.name]) || '';
  const safeName = String(rawName).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'Pet';
  const sizeMatch = String(order.product_sku || '').match(/(\d+x\d+)/);
  const size = sizeMatch ? sizeMatch[1] : '11x14';
  return `${safeName}-tribute-${size}.jpg`;
}

/**
 * Boot-time readiness report.
 *
 * Most of what this store needs to actually take an order is configuration,
 * not code, and nearly every way it can be missing fails QUIETLY: without SMTP
 * every email is logged instead of sent, so a customer pays and hears nothing;
 * without ADMIN_EMAIL nobody is told a paid order is waiting to be reviewed;
 * without a mounted volume the database and the customer's photos live on
 * container disk and are wiped by the next deploy. None of that raises an
 * error — the site looks perfectly healthy while orders quietly go nowhere.
 *
 * So we say it out loud at boot, where Railway's own log will show it without
 * needing the admin dashboard (which itself needs configuration). Presence
 * only: no secret is ever printed.
 */
function logReadiness() {
  const has = (name) => {
    const v = process.env[name];
    return !!(v && String(v).trim() && !/^(your-|sk-ant-placeholder|change-me|pk_test_placeholder|sk_test_placeholder|whsec_placeholder)/.test(String(v).trim()));
  };
  const line = (ok, label, detail) =>
    `  ${ok ? '[ok]  ' : '[MISS]'} ${label.padEnd(22)} ${ok ? '' : detail}`;

  // Storage that survives a redeploy. Default is a directory inside the app,
  // which on Railway is ephemeral — the classic silent data-loss setup.
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const persistent = !!process.env.DATA_DIR && !dataDir.startsWith(__dirname);

  const emailOk = has('SMTP_HOST') || has('RESEND_API_KEY');
  const blocking = [
    [has('STRIPE_SECRET_KEY') && has('STRIPE_WEBHOOK_SECRET'), 'Payments',
      'STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET — checkout cannot complete'],
    [emailOk, 'Email delivery',
      'SMTP_HOST (or RESEND_API_KEY) — every email is only logged, so customers hear NOTHING'],
    [has('ADMIN_EMAIL'), 'Review alerts',
      'ADMIN_EMAIL — nobody is told when a paid order is waiting for review'],
    [has('ADMIN_PASSWORD'), 'Admin dashboard',
      'ADMIN_PASSWORD — /admin is disabled, and proofs can only be sent from there'],
    [persistent, 'Persistent storage',
      'DATA_DIR is inside the app — orders, photos and proofs are LOST on every deploy'],
  ];
  const degraded = [
    [has('ANTHROPIC_API_KEY'), 'AI poems', 'ANTHROPIC_API_KEY — falls back to a template poem'],
    [has('LUMA_API_KEY') && has('LUMA_API_SECRET'), 'Fulfilment',
      'LUMA_API_KEY / LUMA_API_SECRET — approved orders cannot be sent to the printer'],
    [has('LUMA_STORE_ID'), 'Luma store id', 'LUMA_STORE_ID — run GET /api/luma/setup once'],
  ];

  const failed = blocking.filter(([ok]) => !ok);
  console.log('  ── Readiness ' + '─'.repeat(46));
  blocking.forEach(([ok, l, d]) => console.log(line(ok, l, d)));
  degraded.forEach(([ok, l, d]) => console.log(line(ok, l, d)));
  console.log('  ' + '─'.repeat(58));
  if (failed.length) {
    console.warn(`  ${failed.length} setting(s) above will stop real orders from completing.`);
    console.warn('  The site will still serve pages and take payments — it just cannot finish the job.\n');
  } else {
    console.log('  Ready to take and fulfil orders.\n');
  }
}

// Initialize database (creates tables via migrations)
async function start() {
  const db = await require('./src/db/database').init();

  // Webhooks need raw body for signature verification (must be before express.json)
  app.use('/api/whcc-webhooks', express.raw({ type: '*/*' }));
  app.use('/api/luma-webhooks', express.raw({ type: 'application/json' }));
  app.use('/api/stripe-webhooks', express.raw({ type: 'application/json' }));

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'", "'unsafe-inline'",
          "https://www.googletagmanager.com",
          "https://www.google-analytics.com",
          "https://connect.facebook.net",
          "https://www.googleadservices.com",
          "https://googleads.g.doubleclick.net",
        ],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        // blob: is required for the customizer's instant photo preview. When a
        // customer picks their pet's photo we render it from a local
        // URL.createObjectURL(file) blob immediately, then swap in the server
        // thumbnail once the upload returns. Without blob: the CSP blocked that
        // first render, so the preview stayed empty until a 3-5MB upload
        // finished — on mobile, seconds of nothing at the exact moment the
        // photo is supposed to appear — and the upload-failure fallback
        // ("using local preview") had no preview to fall back to.
        imgSrc: ["'self'", "data:", "blob:", "https://www.google-analytics.com", "https://www.facebook.com", "https://www.googletagmanager.com"],
        connectSrc: [
          "'self'",
          "https://www.google-analytics.com",
          "https://analytics.google.com",
          "https://www.facebook.com",
          "https://region1.google-analytics.com",
        ],
        frameSrc: ["'self'", "https://js.stripe.com"],
      },
    },
    crossOriginEmbedderPolicy: false,
  }));

  // Rate limiting — general.
  //
  // Skips GET/HEAD requests for public pages and static assets. This limiter is
  // abuse protection for the write/expensive paths; applying it to reads meant a
  // single visitor loading ~15 subresources per page — or Googlebot crawling
  // from one IP — could burn 200 requests in minutes and start receiving 429s.
  // Google reads sustained 429s as a server-health signal and throttles crawl
  // rate, so this was quietly capping how much of the site could get indexed.
  // Non-GET requests and everything under /api are still fully limited, and the
  // per-route limiters below (poems, uploads, checkout) are the real defense.
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) =>
      (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/'),
  });
  app.use(generalLimiter);

  // Rate limiting — expensive endpoints
  const expensiveLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many requests. Please try again in a few minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  // Poem GENERATION gets its own bucket (same reasoning as gift-note below).
  // The old '/api/poems' mount also counted the cheap library GET that every
  // customizer page load fires, so a buyer using their full 6-generation
  // budget (3 poems + 3 letters) could be 429'd mid-purchase.
  // This per-IP ceiling must stay above the combined per-session budgets in
  // routes/api.js (5 free-tool + 10 customizer per hour), or the free tool
  // could still 429 a buyer at checkout from the IP layer instead.
  app.use('/api/poems/generate', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 18,
    message: { error: 'Too many requests. Please try again in a few minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
  }));
  app.use('/api/sympathy', expensiveLimiter);
  app.use('/api/images/upload', expensiveLimiter);
  // Gift-note drafting gets its OWN bucket rather than joining expensiveLimiter.
  // That middleware is one instance, so every path mounted on it shares a single
  // 10-per-15-min counter — a buyer who drafts notes while regenerating poems
  // would burn the poem budget and get 429'd in the middle of a purchase.
  app.use('/api/gift-note', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 15,
    message: { error: 'Too many requests. Please try again in a few minutes.' },
    standardHeaders: true,
    legacyHeaders: false,
  }));
  // Proof rendering gets its OWN bucket, and the checkout limiter below skips
  // it. Same reasoning as the poem/gift-note split above: the customer now
  // renders a real proof before paying and re-renders it after every edit, so
  // sharing one 20-request budget with checkout itself would 429 a careful
  // buyer at the exact moment they are trying to hand over money. The render
  // is server work, so it still gets a ceiling — just its own.
  app.use('/api/checkout/proof', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    message: { error: 'Too many proof updates. Please give it a minute and try again.' },
    standardHeaders: true,
    legacyHeaders: false,
  }));
  app.use('/api/checkout', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many checkout attempts. Please try again shortly.' },
    // req.path is mount-relative here, so the proof endpoint is '/proof'.
    skip: (req) => req.path === '/proof',
  }));

  // Middleware
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Trust Railway's reverse proxy — required so the `secure` session cookie is
  // actually set over HTTPS in production. Without this, every request starts a
  // fresh session and uploaded photos are lost by checkout time.
  app.set('trust proxy', 1);

  // Sessions – file-backed, 30-day expiry
  app.use(session({
    store: new FileStore({
      path: SESSIONS_DIR,
      ttl: 30 * 24 * 60 * 60, // 30 days in seconds
      retries: 0,
      logFn: () => {}          // suppress noisy logs
    }),
    secret: process.env.SESSION_SECRET || (process.env.NODE_ENV === 'production'
      ? (() => { throw new Error('SESSION_SECRET must be set in production'); })()
      : 'still-beside-me-dev-secret'),
    resave: false,
    saveUninitialized: true,
    cookie: {
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production'
    }
  }));

  // Make db available to routes
  app.locals.db = db;

  // Automated database backups → DATA_DIR/backups (rotating, keep 14). Protects
  // against app-level corruption and gives an off-site pull point (paired with
  // the gated /admin/api/backup download). Runs at boot, then daily.
  const { backupNow } = require('./src/db/database');
  const runBackup = () => {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      backupNow(stamp);
    } catch (err) {
      console.error('DB backup failed:', err.message);
    }
  };
  runBackup();
  setInterval(runBackup, 24 * 60 * 60 * 1000).unref();

  // Story Vault date engine → sends birthday / gotcha / anniversary emails to
  // opted-in families. Same daily-timer shape as the backup above, but gated
  // OFF by default: it only runs when DATE_ENGINE_ENABLED === 'true', so it
  // stays dormant until deliberately switched on in production (no accidental
  // emails from dev or a fresh deploy). At most one email per occasion per year
  // is enforced by the engine + a UNIQUE log constraint.
  if (process.env.DATE_ENGINE_ENABLED === 'true') {
    const { checkAndSend } = require('./src/services/dateEngine');
    const runDateEngine = () => {
      checkAndSend().catch((err) => console.error('Vault date engine failed:', err.message));
    };
    runDateEngine();
    setInterval(runDateEngine, 24 * 60 * 60 * 1000).unref();
  }

  // Proof-approval reminders → nudges customers whose paid order is stuck in
  // proof_ready waiting on their approval. Same daily-timer shape as the two
  // above, but gated ON by default: this is transactional, not marketing. The
  // money is already taken and the order cannot move without the customer, so
  // silence here means a family paid and got nothing. Set
  // PROOF_REMINDERS_ENABLED=false to switch it off. At most two reminders per
  // order ever (3 days, then 7), enforced by proof_reminder_sent order_events.
  if (process.env.PROOF_REMINDERS_ENABLED !== 'false') {
    const { checkAndSend } = require('./src/services/followupEngine');
    const runProofReminders = () => {
      checkAndSend().catch((err) => console.error('Proof reminder engine failed:', err.message));
    };
    runProofReminders();
    setInterval(runProofReminders, 24 * 60 * 60 * 1000).unref();
  }

  // ── Letter From Heaven is discontinued ────────────────────────────────
  // LFH and its human-loss landing pages are permanently off sale, so they
  // return 410 Gone (not a 302). 410 tells Google to DROP these URLs and stop
  // showing their stale "$84.95 / handcrafted frame" snippets; a 302 kept them
  // indexed as "temporarily moved". Registered before express.static so the
  // .html files never serve. The legacy human-loss landing pages (fabricated
  // testimonials, stale $84.95 pricing, "handcrafted" frame language) have been
  // deleted from public/; these routes keep their URLs returning 410 Gone. To
  // restore LFH: recreate the pages and remove "hidden": true from
  // src/data/templates/letter-from-heaven.json.
  const lfhGonePages = [
    '/letter-from-heaven',
    '/loss-of-mother-gift',
    '/loss-of-father-gift',
    '/loss-of-husband-gift',
    '/loss-of-wife-gift',
    '/loss-of-sister-gift',
    '/loss-of-brother-gift',
    '/loss-of-child-gift',
    '/loss-of-grandmother-gift',
    '/loss-of-grandfather-gift',
    '/loss-of-best-friend-gift',
    '/memorial-gift-for-anniversary-of-death',
    '/sympathy-gift-for-coworker'
  ];
  const lfhGoneHtml =
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<title>No longer available &middot; Still Beside Me</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;' +
    'font-family:Georgia,\'Times New Roman\',serif;background:#faf8f5;color:#2a2a2a;text-align:center;padding:24px}' +
    '.g{max-width:34rem}h1{font-size:1.6rem;font-weight:600;margin:0 0 12px}' +
    'p{color:#6b6560;line-height:1.6;margin:0 0 24px}' +
    'a{display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:12px 24px;border-radius:6px}</style>' +
    '</head><body><div class="g"><h1>This tribute is no longer available</h1>' +
    '<p>We now focus on personalized pet memorial tributes &ndash; a poem written from your memories, ' +
    'printed beside their photo and framed.</p>' +
    '<a href="/">See our pet tributes</a></div></body></html>';
  for (const p of lfhGonePages) {
    app.get([p, `${p}.html`], (req, res) => res.status(410).type('html').send(lfhGoneHtml));
  }
  // Old LFH builder URL → the live pet builder (permanent move).
  app.get(['/customize/letter-from-heaven', '/customize/letter-from-heaven.html'], (req, res) => {
    res.redirect(301, '/customize/pet-tribute');
  });
  // ── end discontinued LFH block ────────────────────────────────────────

  // Every page is reachable at BOTH /page and /page.html, because express.static
  // serves files by their raw filename. Self-referencing canonicals already tell
  // Google which one counts, but a canonical is a hint and a 301 is a directive —
  // this collapses the duplicate outright. Registered before express.static so
  // the redirect wins over the file. Explicit list rather than a blanket
  // ".html -> strip extension" rule: /404.html and the token-served admin pages
  // have no clean-URL equivalent and would redirect into a 404.
  const CLEAN_URL_PAGES = [
    'index', 'the-writing', 'pet-memorial-gifts', 'sympathy-gifts', 'memorial-gifts',
    'dog-memorial-gifts', 'cat-memorial-gifts', 'sympathy-message-helper',
    'pet-memorial-poem-generator', 'rainbow-bridge-poem-for-dogs', 'rainbow-bridge-poem-for-cats',
    'privacy-policy', 'terms', 'refund-policy', 'shipping-policy', 'contact', 'about',
  ];
  for (const page of CLEAN_URL_PAGES) {
    app.get(`/${page}.html`, (req, res) =>
      res.redirect(301, page === 'index' ? '/' : `/${page}`));
  }
  const CLEAN_URL_BLOG = [
    'how-to-write-sympathy-card', 'first-year-after-losing-pet',
    'personalized-memorial-gifts-vs-flowers', 'what-to-get-someone-who-lost-a-dog',
    'pet-memorial-poems', 'what-to-send-instead-of-flowers', 'best-memorial-gifts-that-last',
    'what-to-say-when-a-friends-dog-dies',
  ];
  app.get('/blog/index.html', (req, res) => res.redirect(301, '/blog'));
  // Requesting the error page directly used to answer 200 — a soft 404, which
  // Google flags. Serve the same page with the status it describes.
  app.get('/404.html', (req, res) =>
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));
  for (const post of CLEAN_URL_BLOG) {
    app.get(`/blog/${post}.html`, (req, res) => res.redirect(301, `/blog/${post}`));
  }

  // Client-side analytics config — /js/env.js exposes ONLY the public ad/pixel
  // IDs that are actually set. Registered before express.static so it always
  // wins over any static file of the same name. Always valid JS, even when
  // nothing is configured.
  app.get('/js/env.js', (req, res) => {
    const env = {};
    if (process.env.META_PIXEL_ID) env.metaPixelId = process.env.META_PIXEL_ID;
    if (process.env.GOOGLE_ADS_ID) env.googleAdsId = process.env.GOOGLE_ADS_ID;
    if (process.env.GOOGLE_ADS_CONVERSION_LABEL) env.googleAdsLabel = process.env.GOOGLE_ADS_CONVERSION_LABEL;
    res.set('Content-Type', 'application/javascript');
    // This script is parser-blocking in every page's <head> (the Meta Pixel
    // snippet below it reads window.SBM_ENV), so a cache miss costs a full
    // round-trip before the parser can move on. Its contents only change when
    // the ad/pixel env vars change — i.e. on a redeploy — so a 5-minute TTL
    // bought nothing and made mid-session page views re-fetch it. Matches the
    // 1-hour TTL used for the other unhashed /js assets.
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(`window.SBM_ENV=${JSON.stringify(env)};`);
  });

  // Static files.
  //
  // Cache-Control by type: images/fonts/favicons are effectively immutable and
  // get a long TTL; CSS and JS get a short one because they ship unhashed
  // filenames (a long TTL would strand users on stale styles after a deploy);
  // HTML is always revalidated so copy fixes go live immediately. Before this,
  // everything was max-age=0 — every asset cost a revalidation round-trip on
  // every page view, which is a direct hit to repeat-visit load time.
  app.use(express.static(path.join(__dirname, 'public'), {
    // Don't 301 /blog -> /blog/. express.static's directory redirect fired
    // before the explicit app.get('/blog') route below, so the canonical URL
    // (/blog, which is what the page's own canonical tag and the sitemap both
    // declare) answered with a redirect instead of the page. Falling through
    // to the route serves it directly at 200.
    redirect: false,
    setHeaders: (res, filePath) => {
      if (/\.(jpg|jpeg|png|webp|avif|gif|svg|ico|woff2?|ttf)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000'); // 30 days
      } else if (/\.(css|js)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=3600');    // 1 hour
      } else if (/\.html?$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
      }
    },
  }));

  // Restrict /uploads — only authenticated sessions can access uploaded photos
  app.use('/uploads', (req, res, next) => {
    if (!req.session || !req.session.id) {
      return res.status(403).send('Forbidden');
    }
    next();
  }, express.static(UPLOADS_DIR));

  // SEO landing pages – clean URLs
  app.get('/pet-memorial-gifts', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pet-memorial-gifts.html'));
  });
  app.get('/the-writing', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'the-writing.html'));
  });
  app.get('/sympathy-gifts', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sympathy-gifts.html'));
  });
  app.get('/memorial-gifts', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'memorial-gifts.html'));
  });
  app.get('/dog-memorial-gifts', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dog-memorial-gifts.html'));
  });
  app.get('/cat-memorial-gifts', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'cat-memorial-gifts.html'));
  });
  // (The Letter From Heaven / human-loss clean-URL handlers were removed —
  // the 302 redirect block above owns those paths while LFH is off sale.
  // Restore them from letter-from-heaven-era history if LFH returns.)
  app.get('/sympathy-message-helper', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sympathy-message-helper.html'));
  });
  app.get('/pet-memorial-poem-generator', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'pet-memorial-poem-generator.html'));
  });
  app.get('/rainbow-bridge-poem-for-dogs', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'rainbow-bridge-poem-for-dogs.html'));
  });
  app.get('/rainbow-bridge-poem-for-cats', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'rainbow-bridge-poem-for-cats.html'));
  });

  // Blog routes – clean URLs
  app.get('/blog', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog', 'index.html'));
  });
  app.get('/blog/how-to-write-sympathy-card', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog', 'how-to-write-sympathy-card.html'));
  });
  app.get('/blog/first-year-after-losing-pet', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog', 'first-year-after-losing-pet.html'));
  });
  app.get('/blog/personalized-memorial-gifts-vs-flowers', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog', 'personalized-memorial-gifts-vs-flowers.html'));
  });
  app.get('/blog/what-to-get-someone-who-lost-a-dog', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog', 'what-to-get-someone-who-lost-a-dog.html'));
  });
  app.get('/blog/pet-memorial-poems', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog', 'pet-memorial-poems.html'));
  });
  app.get('/blog/what-to-send-instead-of-flowers', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog', 'what-to-send-instead-of-flowers.html'));
  });
  app.get('/blog/best-memorial-gifts-that-last', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog', 'best-memorial-gifts-that-last.html'));
  });
  app.get('/blog/what-to-say-when-a-friends-dog-dies', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'blog', 'what-to-say-when-a-friends-dog-dies.html'));
  });

  // Legal pages – clean URLs
  app.get('/privacy-policy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html'));
  });
  app.get('/terms', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'terms.html'));
  });
  app.get('/refund-policy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'refund-policy.html'));
  });
  app.get('/shipping-policy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'shipping-policy.html'));
  });

  // Contact page
  app.get('/contact', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'contact.html'));
  });

  app.get('/about', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'about.html'));
  });

  // Contact form submission
  app.post('/api/contact', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    message: { error: 'Too many messages. Please try again later.' },
  }), express.json(), async (req, res) => {
    const { name, email, message, orderNumber } = req.body;
    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required.' });
    }
    try {
      // Goes through emailService, NOT a raw nodemailer transport. Railway's
      // network drops outbound SMTP, so the direct-transport version of this
      // handler was timing out and every contact-form message was being lost.
      // emailService routes Resend over its HTTPS API and falls back to logging
      // when no transport is configured.
      const emailService = require('./src/services/emailService');
      await emailService.sendAdminAlert(
        `Contact form: ${name}${orderNumber ? ` (Order #${orderNumber})` : ''}`,
        `Name: ${name}\nEmail: ${email}\nOrder: ${orderNumber || 'N/A'}\n\nMessage:\n${message}\n\n` +
        `Reply directly to ${email}.`
      );
      res.json({ success: true });
    } catch (err) {
      console.error('Contact form error:', err);
      res.status(500).json({ error: 'Failed to send message. Please email us directly.' });
    }
  });

  // Clean URL: /customize and /customize/:templateId → customize.html
  app.get('/customize', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customize.html'));
  });
  app.get('/customize/:templateId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'customize.html'));
  });

  // XML Sitemap
  //
  // lastmod comes from the file's last GIT COMMIT date, not its mtime. On
  // Railway every deploy re-checks-out the repo, so mtime is the deploy
  // timestamp — which made all 23 URLs report the same lastmod, changing on
  // every deploy whether or not any content changed. That is precisely the
  // pattern Google learns to distrust and then ignores. Git dates are the real
  // content-change dates. Resolved once at boot and cached; if git isn't
  // available in the container we omit lastmod entirely rather than emit a
  // date we know is wrong (the element is optional).
  // Prefer the committed manifest (src/data/lastmod.json, written by
  // `npm run lastmod`) because git is not installed in the Railway runtime
  // image. Fall back to a live git call so local dev stays accurate without
  // running the build step, and omit the element entirely if neither works.
  let lastmodManifest = {};
  try {
    lastmodManifest = require('./src/data/lastmod.json');
  } catch (e) {
    console.warn('Sitemap: src/data/lastmod.json missing — run `npm run lastmod`. Falling back to git.');
  }
  const gitLastmodCache = new Map();
  const lastmodFor = (relPath) => {
    if (lastmodManifest[relPath]) return lastmodManifest[relPath];
    if (gitLastmodCache.has(relPath)) return gitLastmodCache.get(relPath);
    let value = null;
    try {
      const out = require('child_process')
        .execFileSync('git', ['log', '-1', '--format=%cs', '--', `public/${relPath}`], {
          cwd: __dirname, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
        })
        .trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(out)) value = out;
    } catch (e) {
      value = null; // git unavailable (or file untracked) — omit the element
    }
    gitLastmodCache.set(relPath, value);
    return value;
  };

  app.get('/sitemap.xml', (req, res) => {
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    const lastmod = (relPath) => {
      const d = lastmodFor(relPath);
      return d ? `
    <lastmod>${d}</lastmod>` : '';
    };
    res.set('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>${lastmod('index.html')}
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${baseUrl}/the-writing</loc>${lastmod('the-writing.html')}
    <changefreq>monthly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/pet-memorial-gifts</loc>${lastmod('pet-memorial-gifts.html')}
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/sympathy-gifts</loc>${lastmod('sympathy-gifts.html')}
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/memorial-gifts</loc>${lastmod('memorial-gifts.html')}
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/dog-memorial-gifts</loc>${lastmod('dog-memorial-gifts.html')}
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/cat-memorial-gifts</loc>${lastmod('cat-memorial-gifts.html')}
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/privacy-policy</loc>${lastmod('privacy-policy.html')}
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${baseUrl}/terms</loc>${lastmod('terms.html')}
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${baseUrl}/refund-policy</loc>${lastmod('refund-policy.html')}
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${baseUrl}/shipping-policy</loc>${lastmod('shipping-policy.html')}
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${baseUrl}/about</loc>${lastmod('about.html')}
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${baseUrl}/contact</loc>${lastmod('contact.html')}
    <changefreq>yearly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog</loc>${lastmod('blog/index.html')}
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/how-to-write-sympathy-card</loc>${lastmod('blog/how-to-write-sympathy-card.html')}
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/first-year-after-losing-pet</loc>${lastmod('blog/first-year-after-losing-pet.html')}
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/personalized-memorial-gifts-vs-flowers</loc>${lastmod('blog/personalized-memorial-gifts-vs-flowers.html')}
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/what-to-get-someone-who-lost-a-dog</loc>${lastmod('blog/what-to-get-someone-who-lost-a-dog.html')}
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/pet-memorial-poems</loc>${lastmod('blog/pet-memorial-poems.html')}
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/what-to-send-instead-of-flowers</loc>${lastmod('blog/what-to-send-instead-of-flowers.html')}
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/best-memorial-gifts-that-last</loc>${lastmod('blog/best-memorial-gifts-that-last.html')}
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/what-to-say-when-a-friends-dog-dies</loc>${lastmod('blog/what-to-say-when-a-friends-dog-dies.html')}
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${baseUrl}/sympathy-message-helper</loc>${lastmod('sympathy-message-helper.html')}
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${baseUrl}/pet-memorial-poem-generator</loc>${lastmod('pet-memorial-poem-generator.html')}
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/rainbow-bridge-poem-for-dogs</loc>${lastmod('rainbow-bridge-poem-for-dogs.html')}
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${baseUrl}/rainbow-bridge-poem-for-cats</loc>${lastmod('rainbow-bridge-poem-for-cats.html')}
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
</urlset>`);
  });

  // API routes
  app.use('/api', require('./src/routes/api'));
  app.use('/api/templates', require('./src/routes/templates'));

  // Checkout & payment
  app.use('/api', require('./src/routes/checkout'));
  app.use('/api/stripe-webhooks', require('./src/routes/stripeWebhooks'));

  // Clean URL for order confirmation
  app.get('/order-confirmed', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order-confirmed.html'));
  });

  // WHCC Print Lab integration
  app.use('/api/whcc', require('./src/routes/whcc'));
  app.use('/api/whcc-editor', require('./src/routes/whccEditor'));
  app.use('/api/whcc-webhooks', require('./src/routes/whccWebhooks'));

  // Luma Prints integration
  app.use('/api/luma', require('./src/routes/luma'));
  app.use('/api/luma-webhooks', require('./src/routes/lumaWebhooks'));

  // Proof approval workflow
  app.use('/api/proof', require('./src/routes/proofApproval'));
  app.get('/proof/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'proof-approval.html'));
  });

  // Digital Keepsake download — same tokenization as /proof/:token (the
  // proof_token doubles as the per-order download key). Serves the rendered
  // 300 DPI file as an attachment. Valid only for delivered digital orders;
  // the link politely expires 90 days after delivery.
  app.get('/download/:token', (req, res) => {
    const token = req.params.token;

    const politeGone = (heading, message) => {
      res.status(404).type('html').send(
        '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
        '<meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<title>Download unavailable – Still Beside Me</title>' +
        '<style>body{font-family:Georgia,"Times New Roman",serif;max-width:34rem;margin:16vh auto;' +
        'padding:0 1.5rem;color:#2b2b2b;line-height:1.6;text-align:center}h1{font-weight:400;font-size:1.6rem}' +
        'a{color:#8a5a44}</style></head><body>' +
        '<h1>' + heading + '</h1><p>' + message + '</p>' +
        '<p>You can <a href="/order">look up your order</a> or <a href="/contact">contact us</a> ' +
        'and we’ll re-send your file.</p></body></html>'
      );
    };

    if (!token || token.length < 8) {
      return politeGone('We couldn’t find that download',
        'This download link doesn’t look right.');
    }

    const order = db.get('SELECT * FROM orders WHERE proof_token = ?', [token]);
    if (!order || order.status !== 'delivered' || !isDigitalOrder(order) || !order.print_file_url) {
      return politeGone('We couldn’t find that download',
        'This link isn’t ready yet, or it belongs to a different kind of order.');
    }

    // Politely expire 90 days after delivery (proof_approved_at is set at delivery).
    const deliveredAt = order.proof_approved_at || order.updated_at;
    const deliveredMs = deliveredAt
      ? new Date(deliveredAt.includes('T') ? deliveredAt : deliveredAt.replace(' ', 'T') + 'Z').getTime()
      : NaN;
    if (!Number.isNaN(deliveredMs) && (Date.now() - deliveredMs) / 86400000 > 90) {
      return politeGone('This download link has expired',
        'Download links stay active for 90 days. We keep your file safe on our end.');
    }

    // Resolve the file from print_file_url (/output/... maps to OUTPUT_DIR).
    const filePath = path.join(OUTPUT_DIR, order.print_file_url.replace(/^\/output\//, ''));
    if (!fs.existsSync(filePath)) {
      return politeGone('We couldn’t find that download',
        'The file isn’t where we expected it to be.');
    }

    res.download(filePath, downloadFilename(order));
  });

  // Partner fulfillment admin (tokenized link from the fulfillment email)
  app.use('/api/admin', require('./src/routes/adminOrder'));
  app.get('/admin/order/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-order.html'));
  });

  // Human review gate (tokenized link from the review-request email).
  // Every proof is approved here before the customer proof email goes out.
  app.use('/api/admin', require('./src/routes/adminReview'));
  app.get('/admin/review/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin-review.html'));
  });

  // Admin dashboard — password-gated all-orders search, event timeline,
  // support notes, and off-site DB backup download (see adminDashboard.js).
  // Mounted after the tokenized /admin/order and /admin/review routes so those
  // specific paths keep taking precedence.
  app.use('/admin', require('./src/routes/adminDashboard'));

  // Order status page (token-based deep link from email, plus lookup form)
  app.use('/api/orders', require('./src/routes/orderStatus'));
  app.get('/order', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order-status.html'));
  });
  app.get('/order/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order-status.html'));
  });

  // Recipient-facing tribute page — the sender texts this link on day one and
  // the QR on the printed note card points at the same URL. Keyed by gift_token,
  // NOT proof_token: this link is printed on paper and forwarded to strangers,
  // so it must not carry the order total, the buyer's details, or the power to
  // approve a proof. See src/routes/tribute.js.
  app.use('/api/tribute', require('./src/routes/tribute'));
  app.get('/tribute/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'tribute.html'));
  });

  // Story Vault — the private, tokenized page that keeps a pet's tribute alive
  // after the frame ships, and (opt-in) sends gentle reminders on the pet's
  // birthday, gotcha day, and anniversary of passing. Keyed by its own vault
  // token: it grants only reading the story, setting the dates, or
  // unsubscribing — never anything about the order, buyer, or price. The
  // date-triggered emails are driven by the DATE_ENGINE_ENABLED timer below.
  app.use('/api/vault', require('./src/routes/vault'));
  app.get('/story/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'story.html'));
  });

  // Serve proof images, print files, and note cards from the output directory.
  //
  // This mount is deliberately UNAUTHENTICATED: Luma's servers fetch the print
  // file and the enclosed note card anonymously when placing an order, so a
  // login gate here would break fulfillment. The correct control is therefore
  // "don't index", not "don't serve" — X-Robots-Tag keeps a customer's tribute
  // artwork (and the sender's private gift note) out of search results even if
  // a URL leaks, and robots.txt Disallows /output/ so it is never crawled.
  app.use('/output', express.static(OUTPUT_DIR, {
    setHeaders: (res) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow, noimageindex');
    },
  }));

  // Email signup — captured into our own DB first (the source of truth, on the
  // /data volume, so no signup is ever lost), then the admin is notified, then
  // it's optionally forwarded to Mailchimp if that's ever configured.
  app.post('/api/subscribe', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many signup attempts.' },
  }), express.json(), async (req, res) => {
    const { email, source } = req.body;
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !EMAIL_RE.test(String(email).trim())) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const clean = String(email).trim().toLowerCase();
    const db = req.app.locals.db;

    // Save to our DB. Only treat it as a NEW subscriber (and only alert once)
    // if the address wasn't already captured.
    let isNew = false;
    try {
      const existing = db.get('SELECT id FROM subscribers WHERE email = ?', [clean]);
      if (!existing) {
        db.run('INSERT INTO subscribers (email, source) VALUES (?, ?)',
          [clean, String(source || 'signup').slice(0, 40)]);
        isNew = true;
      }
    } catch (err) {
      console.error('Subscriber save error:', err.message);
    }

    // Notify the admin of a genuinely new signup (best-effort — a mail failure
    // must not fail the subscribe, and it's already saved either way).
    if (isNew) {
      try {
        const emailService = require('./src/services/emailService');
        await emailService.sendAdminAlert(
          'New email subscriber',
          `Someone signed up for updates.\n\nEmail: ${clean}\nSource: ${source || 'signup'}`
        );
      } catch (err) {
        console.error('Subscriber admin alert failed:', err.message);
      }
    }

    // Optional passthrough to Mailchimp if it's ever wired up (kept so a later
    // switch needs only the two env vars, no code change).
    const apiKey = process.env.MAILCHIMP_API_KEY;
    const listId = process.env.MAILCHIMP_LIST_ID;
    if (apiKey && listId) {
      try {
        const dc = apiKey.split('-')[1];
        await fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${listId}/members`, {
          method: 'POST',
          headers: { 'Authorization': `apikey ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email_address: clean, status: 'subscribed' }),
        });
      } catch (err) {
        console.error('Mailchimp forward error:', err.message);
      }
    }

    res.json({ success: true });
  });

  // Admin: export captured subscribers as CSV (admin token required).
  app.get('/admin/subscribers.csv', (req, res) => {
    if (!process.env.ADMIN_EXPORT_TOKEN || req.query.token !== process.env.ADMIN_EXPORT_TOKEN) {
      return res.status(403).send('Forbidden');
    }
    const rows = req.app.locals.db.all('SELECT email, source, created_at FROM subscribers ORDER BY created_at DESC');
    const csv = 'email,source,created_at\n' +
      rows.map(r => `${r.email},${r.source || ''},${r.created_at}`).join('\n');
    res.set('Content-Type', 'text/csv');
    res.set('Content-Disposition', 'attachment; filename="subscribers.csv"');
    res.send(csv);
  });

  // Sentry error handler (must be before 404 catch-all)
  if (process.env.SENTRY_DSN) {
    Sentry.setupExpressErrorHandler(app);
  }

  // Global error handler
  app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });

  // 404 catch-all (must be last route)
  app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
  });

  const server = app.listen(PORT, () => {
    console.log(`\n  Still Beside Me – Memorial Art Store`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  http://localhost:${PORT}/customize\n`);
    logReadiness();
  });

  // Railway sends SIGTERM when a redeploy replaces this container. Exit 0 so
  // routine shutdowns aren't classified (and emailed) as crashes.
  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
