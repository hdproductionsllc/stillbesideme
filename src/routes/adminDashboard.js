/**
 * Admin Dashboard — the support surface.
 *
 * A password-gated (ADMIN_PASSWORD, via the existing session) view of EVERY
 * order, searchable by email / name / order-id / status, with the full event
 * timeline and an editable support-notes field per order. Also serves a gated
 * database backup download for off-site redundancy.
 *
 * This is separate from adminReview.js / adminOrder.js, which are the
 * per-order tokenized links emailed to the admin. Those still work; this adds
 * the "find any order in seconds" capability they lacked.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();

const { DB_PATH } = require('../db/database');

/** Gate: requires ADMIN_PASSWORD to be configured and the session logged in. */
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(503).send('Admin dashboard is not configured. Set ADMIN_PASSWORD in the environment.');
  }
  if (req.session && req.session.isAdmin) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not authorized' });
  return res.redirect('/admin/login');
}

const loginPage = (error) => `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Admin sign in</title><style>
body{font-family:system-ui,sans-serif;background:#1a1714;color:#f4f1ea;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
form{background:#26211c;padding:32px;border-radius:12px;width:300px}
h1{font-size:1.1rem;margin:0 0 18px}input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #4a4038;background:#1a1714;color:#f4f1ea;margin-bottom:12px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#C4A882;color:#1a1714;font-weight:600;cursor:pointer}
.err{color:#e5a3a3;font-size:.85rem;margin-bottom:10px}</style></head>
<body><form method="POST" action="/admin/login"><h1>Still Beside Me — Admin</h1>
${error ? '<div class="err">Incorrect password.</div>' : ''}
<input type="password" name="password" placeholder="Admin password" autofocus>
<button type="submit">Sign in</button></form></body></html>`;

router.get('/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD) return res.status(503).send('Set ADMIN_PASSWORD to enable the admin dashboard.');
  res.send(loginPage(false));
});

router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (process.env.ADMIN_PASSWORD && req.body.password === process.env.ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin/orders');
  }
  res.status(401).send(loginPage(true));
});

router.post('/logout', (req, res) => {
  if (req.session) req.session.isAdmin = false;
  res.redirect('/admin/login');
});

// Dashboard shell (data loads from the gated API below).
router.get(['/', '/orders'], requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'orders.html'));
});

/** Best-effort extraction of a display name + pet name from stored JSON. */
function summarize(order) {
  let customerName = '';
  let petName = '';
  try {
    const ship = order.shipping_json ? JSON.parse(order.shipping_json) : null;
    if (ship && ship.name) customerName = ship.name;
  } catch (e) { /* ignore */ }
  try {
    const f = order.fields_json ? JSON.parse(order.fields_json) : {};
    petName = f.petName || f.name || '';
  } catch (e) { /* ignore */ }
  return { customerName, petName };
}

// List / search orders. Loads recent orders and filters in JS (order volume is
// low; simple and flexible). Searches email, order-id prefix, customer name,
// and pet name.
router.get('/api/orders', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const q = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim();

  const params = [];
  let sql = 'SELECT * FROM orders';
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY created_at DESC LIMIT 1000';
  const rows = db.all(sql, params);

  const list = rows.map(o => {
    const { customerName, petName } = summarize(o);
    return {
      id: o.id,
      shortId: o.id.substring(0, 8).toUpperCase(),
      email: o.email || '',
      customerName,
      petName,
      sku: o.product_sku || '',
      totalCents: o.total_cents,
      status: o.status,
      adminToken: o.admin_token || null,
      proofToken: o.proof_token || null,
      hasNotes: !!(o.admin_notes && o.admin_notes.trim()),
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    };
  }).filter(o => {
    if (!q) return true;
    return o.email.toLowerCase().includes(q)
      || o.id.toLowerCase().startsWith(q)
      || o.shortId.toLowerCase().startsWith(q)
      || o.customerName.toLowerCase().includes(q)
      || o.petName.toLowerCase().includes(q);
  });

  res.json({ orders: list, total: list.length });
});

// One order: full detail + the complete event timeline + notes.
router.get('/api/orders/:id', requireAdmin, (req, res) => {
  const db = req.app.locals.db;
  const o = db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: 'Order not found' });

  const events = db.all(
    'SELECT event_type, data_json, created_at FROM order_events WHERE order_id = ? ORDER BY id ASC',
    [o.id]
  );
  // Fulfillment audit trail: the exact payload sent to Luma and their response,
  // one row per submission attempt (written by lumaOrderApi.placeOrder).
  const lumaOrders = db.all(
    'SELECT luma_order_number, status, error_message, request_json, response_json, created_at FROM luma_orders WHERE order_id = ? ORDER BY id ASC',
    [o.id]
  );
  const { customerName, petName } = summarize(o);
  let shipping = null;
  try { shipping = o.shipping_json ? JSON.parse(o.shipping_json) : null; } catch (e) { /* ignore */ }

  res.json({
    order: {
      id: o.id,
      shortId: o.id.substring(0, 8).toUpperCase(),
      status: o.status,
      email: o.email || '',
      customerName,
      petName,
      sku: o.product_sku || '',
      totalCents: o.total_cents,
      templateId: o.template_id,
      poemText: o.poem_text || '',
      shipping,
      tracking: o.tracking_number ? { number: o.tracking_number, carrier: o.tracking_carrier, url: o.tracking_url } : null,
      fulfillmentProvider: o.fulfillment_provider || '',
      stripePaymentIntentId: o.stripe_payment_intent_id || '',
      proofUrl: o.proof_url || '',
      adminToken: o.admin_token || null,
      proofToken: o.proof_token || null,
      adminNotes: o.admin_notes || '',
      createdAt: o.created_at,
      updatedAt: o.updated_at,
    },
    events: events.map(e => ({ type: e.event_type, data: e.data_json, at: e.created_at })),
    lumaOrders: lumaOrders.map(l => ({
      lumaOrderNumber: l.luma_order_number,
      status: l.status,
      errorMessage: l.error_message,
      request: l.request_json,
      response: l.response_json,
      at: l.created_at,
    })),
  });
});

// Save support notes.
router.post('/api/orders/:id/notes', requireAdmin, express.json(), (req, res) => {
  const db = req.app.locals.db;
  const o = db.get('SELECT id FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  const notes = String(req.body.notes || '').slice(0, 5000);
  db.run("UPDATE orders SET admin_notes = ?, updated_at = datetime('now') WHERE id = ?", [notes, o.id]);
  res.json({ success: true });
});

// Re-send the transactional emails for a paid order whose original sends
// failed (e.g. an SMTP outage): customer order confirmation, and — when the
// order is still waiting on review — the admin review request. Only re-sends;
// never changes order state, so it is safe to repeat.
router.post('/api/orders/:id/resend-emails', requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const o = db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (o.status === 'pending_payment' || o.status === 'cancelled') {
    return res.status(400).json({ error: `Order is ${o.status} — nothing to send.` });
  }

  const emailService = require('../services/emailService');
  const baseUrl = process.env.BASE_URL || 'http://localhost:3001';
  const results = {};

  if (o.email && o.proof_token) {
    try {
      let fields = {};
      try { fields = o.fields_json ? JSON.parse(o.fields_json) : {}; } catch (e) { /* ignore */ }
      const giftUrl = fields.orderType === 'gift' && o.gift_token ? `${baseUrl}/tribute/${o.gift_token}` : null;
      await emailService.sendOrderConfirmation(o.email, {
        orderId: o.id,
        templateName: o.template_id,
        sku: o.product_sku,
        totalCents: o.total_cents,
      }, `${baseUrl}/order/${o.proof_token}`, giftUrl);
      results.confirmation = 'sent';
    } catch (e) {
      results.confirmation = `failed: ${e.message}`;
    }
  } else {
    results.confirmation = 'skipped (no email on order)';
  }

  const reviewable = o.status === 'awaiting_review' || o.status === 'change_requested';
  if (reviewable && o.admin_token && o.proof_url) {
    try {
      await emailService.sendReviewRequest(o, {
        reviewUrl: `${baseUrl}/admin/review/${o.admin_token}`,
        proofImageUrl: `${baseUrl}${o.proof_url}`,
      });
      results.review = 'sent';
    } catch (e) {
      results.review = `failed: ${e.message}`;
    }
  } else {
    results.review = reviewable ? 'skipped (no proof yet)' : `skipped (status ${o.status})`;
  }

  db.run(
    'INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)',
    [o.id, 'emails_resent', JSON.stringify(results)]
  );
  res.json({ success: true, results });
});

// Re-pull email + shipping address from the Stripe checkout session and fill
// any missing fields on the order. Recovery for orders damaged by the Stripe
// API-version drift (shipping moved to collected_information.shipping_details;
// the webhook missed it before 2026-07-19). Only fills blanks — never
// overwrites data already on the order.
router.post('/api/orders/:id/sync-stripe', requireAdmin, async (req, res) => {
  const db = req.app.locals.db;
  const o = db.get('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (!o.stripe_session_id) return res.status(400).json({ error: 'Order has no Stripe session id' });

  try {
    const Stripe = require('stripe');
    // Pin a modern API version so collected_information is available
    // (the account default is too old to return it).
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
    const session = await stripe.checkout.sessions.retrieve(o.stripe_session_id, {
      expand: ['collected_information.shipping_details'],
    });

    const collected = session.collected_information?.shipping_details
      || session.shipping_details
      || session.shipping
      || null;
    let shippingJson = null;
    if (collected) {
      const addr = collected.address || {};
      shippingJson = JSON.stringify({
        name: collected.name || '',
        address1: addr.line1 || '',
        address2: addr.line2 || '',
        city: addr.city || '',
        state: addr.state || '',
        zip: addr.postal_code || '',
        country: addr.country || 'US',
      });
    }
    const email = session.customer_details?.email || '';

    db.run(
      `UPDATE orders SET
         email = COALESCE(NULLIF(email, ''), ?),
         shipping_json = COALESCE(shipping_json, ?),
         updated_at = datetime('now')
       WHERE id = ?`,
      [email, shippingJson, o.id]
    );
    db.run(
      'INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)',
      [o.id, 'stripe_synced', JSON.stringify({ hadShipping: !!o.shipping_json, foundShipping: !!shippingJson, email })]
    );

    const updated = db.get('SELECT email, shipping_json FROM orders WHERE id = ?', [o.id]);
    res.json({
      success: true,
      email: updated.email,
      shipping: updated.shipping_json ? JSON.parse(updated.shipping_json) : null,
    });
  } catch (e) {
    console.error(`Stripe sync failed for order ${o.id}:`, e.message);
    res.status(502).json({ error: `Stripe sync failed: ${e.message}` });
  }
});

// Off-site backup: download the live database file (gated).
router.get('/api/backup', requireAdmin, (req, res) => {
  if (!DB_PATH || !fs.existsSync(DB_PATH)) return res.status(404).send('No database file found.');
  res.download(DB_PATH, `store-backup.db`);
});

module.exports = router;
