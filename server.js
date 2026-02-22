require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const FileStore = require('session-file-store')(session);

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

// Initialize database (creates tables via migrations)
async function start() {
  const db = await require('./src/db/database').init();

  // Webhooks need raw body for signature verification (must be before express.json)
  app.use('/api/whcc-webhooks', express.raw({ type: '*/*' }));
  app.use('/api/luma-webhooks', express.raw({ type: 'application/json' }));
  app.use('/api/stripe-webhooks', express.raw({ type: 'application/json' }));

  // Middleware
  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ extended: true }));

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

  // Static files
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/uploads', express.static(UPLOADS_DIR));

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
  app.get('/loss-of-mother-gift', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loss-of-mother-gift.html'));
  });
  app.get('/loss-of-father-gift', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loss-of-father-gift.html'));
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
    const today = new Date().toISOString().split('T')[0];
    res.set('Content-Type', 'application/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${baseUrl}/</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${baseUrl}/pet-memorial-gifts</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/sympathy-gifts</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/memorial-gifts</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/dog-memorial-gifts</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/cat-memorial-gifts</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/loss-of-mother-gift</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/loss-of-father-gift</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/customize/pet-tribute</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/customize/letter-from-heaven</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/how-to-write-sympathy-card</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/first-year-after-losing-pet</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/personalized-memorial-gifts-vs-flowers</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
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

  app.listen(PORT, () => {
    console.log(`\n  Still Beside Me – Memorial Art Store`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  http://localhost:${PORT}/customize\n`);
  });
}

start().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});
