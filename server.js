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
        imgSrc: ["'self'", "data:", "https://www.google-analytics.com", "https://www.facebook.com", "https://www.googletagmanager.com"],
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

  // Rate limiting — general
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
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
  app.use('/api/poems', expensiveLimiter);
  app.use('/api/sympathy', expensiveLimiter);
  app.use('/api/images/upload', expensiveLimiter);
  app.use('/api/checkout', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { error: 'Too many checkout attempts. Please try again shortly.' },
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

  // ── TEMPORARY: Letter From Heaven is off sale ─────────────────────────
  // 302 (temporary) redirects for LFH and its human-loss landing pages.
  // Registered before express.static so the .html files are not served.
  // To restore LFH: delete this block and remove "hidden": true from
  // src/data/templates/letter-from-heaven.json.
  const lfhOffSaleRedirects = [
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
  for (const p of lfhOffSaleRedirects) {
    app.get([p, `${p}.html`], (req, res) => res.redirect(302, '/'));
  }
  app.get(['/customize/letter-from-heaven', '/customize/letter-from-heaven.html'], (req, res) => {
    res.redirect(302, '/customize/pet-tribute');
  });
  // ── end temporary LFH block ───────────────────────────────────────────

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
    res.set('Cache-Control', 'public, max-age=300');
    res.send(`window.SBM_ENV=${JSON.stringify(env)};`);
  });

  // Static files
  app.use(express.static(path.join(__dirname, 'public')));

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
      const nodemailer = require('nodemailer');
      const adminEmail = process.env.ADMIN_EMAIL || 'hello@stillbesideme.com';
      if (process.env.SMTP_HOST) {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: parseInt(process.env.SMTP_PORT) || 587,
          auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        });
        await transporter.sendMail({
          from: process.env.EMAIL_FROM || `Still Beside Me <${adminEmail}>`,
          to: adminEmail,
          replyTo: email,
          subject: `Contact Form: ${name}${orderNumber ? ` (Order #${orderNumber})` : ''}`,
          text: `Name: ${name}\nEmail: ${email}\nOrder: ${orderNumber || 'N/A'}\n\nMessage:\n${message}`,
        });
      } else {
        console.log('[Contact Form]', { name, email, orderNumber, message });
      }
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
  app.get('/sitemap.xml', (req, res) => {
    const baseUrl = process.env.BASE_URL || `http://localhost:${PORT}`;
    // lastmod = real file modification date; fixed launch date for anything without a file
    const SITEMAP_FALLBACK_DATE = '2026-06-01';
    const lastmod = (relPath) => {
      try {
        return fs.statSync(path.join(__dirname, 'public', relPath)).mtime.toISOString().split('T')[0];
      } catch (e) {
        return SITEMAP_FALLBACK_DATE;
      }
    };
    res.set('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${lastmod('index.html')}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${baseUrl}/pet-memorial-gifts</loc>
    <lastmod>${lastmod('pet-memorial-gifts.html')}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/sympathy-gifts</loc>
    <lastmod>${lastmod('sympathy-gifts.html')}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/memorial-gifts</loc>
    <lastmod>${lastmod('memorial-gifts.html')}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/dog-memorial-gifts</loc>
    <lastmod>${lastmod('dog-memorial-gifts.html')}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/cat-memorial-gifts</loc>
    <lastmod>${lastmod('cat-memorial-gifts.html')}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/privacy-policy</loc>
    <lastmod>${lastmod('privacy-policy.html')}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${baseUrl}/terms</loc>
    <lastmod>${lastmod('terms.html')}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${baseUrl}/refund-policy</loc>
    <lastmod>${lastmod('refund-policy.html')}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${baseUrl}/shipping-policy</loc>
    <lastmod>${lastmod('shipping-policy.html')}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${baseUrl}/contact</loc>
    <lastmod>${lastmod('contact.html')}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.5</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog</loc>
    <lastmod>${lastmod('blog/index.html')}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/how-to-write-sympathy-card</loc>
    <lastmod>${lastmod('blog/how-to-write-sympathy-card.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/first-year-after-losing-pet</loc>
    <lastmod>${lastmod('blog/first-year-after-losing-pet.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/personalized-memorial-gifts-vs-flowers</loc>
    <lastmod>${lastmod('blog/personalized-memorial-gifts-vs-flowers.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/what-to-get-someone-who-lost-a-dog</loc>
    <lastmod>${lastmod('blog/what-to-get-someone-who-lost-a-dog.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/pet-memorial-poems</loc>
    <lastmod>${lastmod('blog/pet-memorial-poems.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/what-to-send-instead-of-flowers</loc>
    <lastmod>${lastmod('blog/what-to-send-instead-of-flowers.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/best-memorial-gifts-that-last</loc>
    <lastmod>${lastmod('blog/best-memorial-gifts-that-last.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/sympathy-message-helper</loc>
    <lastmod>${lastmod('sympathy-message-helper.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${baseUrl}/pet-memorial-poem-generator</loc>
    <lastmod>${lastmod('pet-memorial-poem-generator.html')}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/rainbow-bridge-poem-for-dogs</loc>
    <lastmod>${lastmod('rainbow-bridge-poem-for-dogs.html')}</lastmod>
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

  // Order status page (token-based deep link from email, plus lookup form)
  app.use('/api/orders', require('./src/routes/orderStatus'));
  app.get('/order', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order-status.html'));
  });
  app.get('/order/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'order-status.html'));
  });

  // Serve proof images from output directory
  app.use('/output', express.static(OUTPUT_DIR));

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
