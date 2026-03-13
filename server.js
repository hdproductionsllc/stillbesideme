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
  app.get('/loss-of-mother-gift', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loss-of-mother-gift.html'));
  });
  app.get('/loss-of-father-gift', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loss-of-father-gift.html'));
  });
  app.get('/loss-of-husband-gift', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loss-of-husband-gift.html'));
  });
  app.get('/loss-of-wife-gift', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loss-of-wife-gift.html'));
  });
  app.get('/loss-of-grandmother-gift', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loss-of-grandmother-gift.html'));
  });
  app.get('/loss-of-grandfather-gift', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loss-of-grandfather-gift.html'));
  });
  app.get('/loss-of-child-gift', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loss-of-child-gift.html'));
  });
  app.get('/loss-of-brother-gift', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loss-of-brother-gift.html'));
  });
  app.get('/loss-of-sister-gift', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loss-of-sister-gift.html'));
  });
  app.get('/loss-of-best-friend-gift', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'loss-of-best-friend-gift.html'));
  });
  app.get('/sympathy-gift-for-coworker', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sympathy-gift-for-coworker.html'));
  });
  app.get('/memorial-gift-for-anniversary-of-death', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'memorial-gift-for-anniversary-of-death.html'));
  });
  app.get('/letter-from-heaven', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'letter-from-heaven.html'));
  });
  app.get('/sympathy-message-helper', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'sympathy-message-helper.html'));
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
    <loc>${baseUrl}/loss-of-husband-gift</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/loss-of-wife-gift</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/loss-of-grandmother-gift</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/loss-of-grandfather-gift</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/loss-of-child-gift</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/loss-of-brother-gift</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/loss-of-sister-gift</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/loss-of-best-friend-gift</loc>
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
    <loc>${baseUrl}/privacy-policy</loc>
    <lastmod>${today}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${baseUrl}/terms</loc>
    <lastmod>${today}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${baseUrl}/refund-policy</loc>
    <lastmod>${today}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${baseUrl}/shipping-policy</loc>
    <lastmod>${today}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${baseUrl}/contact</loc>
    <lastmod>${today}</lastmod>
    <changefreq>yearly</changefreq>
    <priority>0.5</priority>
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
  <url>
    <loc>${baseUrl}/blog/what-to-get-someone-who-lost-a-dog</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/pet-memorial-poems</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/what-to-send-instead-of-flowers</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/blog/best-memorial-gifts-that-last</loc>
    <lastmod>${today}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.6</priority>
  </url>
  <url>
    <loc>${baseUrl}/sympathy-gift-for-coworker</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/memorial-gift-for-anniversary-of-death</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>
  <url>
    <loc>${baseUrl}/letter-from-heaven</loc>
    <lastmod>${today}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
  <url>
    <loc>${baseUrl}/sympathy-message-helper</loc>
    <lastmod>${today}</lastmod>
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

  // Serve proof images from output directory
  app.use('/output', express.static(OUTPUT_DIR));

  // Mailchimp email signup proxy (avoids exposing API key to browser)
  app.post('/api/subscribe', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many signup attempts.' },
  }), express.json(), async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required.' });
    const apiKey = process.env.MAILCHIMP_API_KEY;
    const listId = process.env.MAILCHIMP_LIST_ID;
    if (!apiKey || !listId) {
      console.log('[Email Signup]', email);
      return res.json({ success: true });
    }
    try {
      const dc = apiKey.split('-')[1]; // e.g. us21
      const response = await fetch(`https://${dc}.api.mailchimp.com/3.0/lists/${listId}/members`, {
        method: 'POST',
        headers: {
          'Authorization': `apikey ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email_address: email,
          status: 'subscribed',
        }),
      });
      const data = await response.json();
      if (response.ok || data.title === 'Member Exists') {
        return res.json({ success: true });
      }
      return res.status(400).json({ error: 'Could not subscribe. Please try again.' });
    } catch (err) {
      console.error('Mailchimp error:', err);
      res.status(500).json({ error: 'Subscription failed. Please try again.' });
    }
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
