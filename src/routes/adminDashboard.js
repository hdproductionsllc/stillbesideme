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

// Off-site backup: download the live database file (gated).
router.get('/api/backup', requireAdmin, (req, res) => {
  if (!DB_PATH || !fs.existsSync(DB_PATH)) return res.status(404).send('No database file found.');
  res.download(DB_PATH, `store-backup.db`);
});

module.exports = router;
