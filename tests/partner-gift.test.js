/**
 * Partner gifts: a practice's link lets a family make a free keepsake.
 *
 * Pinned against a real (temporary) database, through the real Express routers
 * with a real session cookie:
 *
 *   1. /gift/<slug> remembers the practice and opens the designer; an unknown
 *      slug gets a kind 404. /api/partner-gift tells the designer who it is
 *      from and whether the link can give one right now.
 *   2. The free keepsake can only be ordered by someone who came through a
 *      link. Placing it never touches Stripe, needs an email, lands in
 *      awaiting_review like any order, and records the partner.
 *   3. The limits hold: one keepsake per email per practice, the monthly cap,
 *      and a paused link. A paused or capped link still credits the practice.
 *   4. A framed order is credited to the practice, both from the link's own
 *      session and later from the gift's saved design on another device.
 *   5. Approving a gift delivers the screen-size keepsake (never the print
 *      file), mints no upgrade credit, and emails a "Have it framed" link that
 *      reopens their design.
 *   6. The gift is a digital order everywhere, but never part of the products
 *      the shop sells ("from $X" stays a real price).
 *
 *   node tests/partner-gift.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Environment BEFORE any module under test loads: they read it at require time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbm-partner-gift-test-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.BASE_URL = 'https://example.test';
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.FULFILLMENT_PROVIDER = 'luma';
delete process.env.SMTP_HOST;
delete process.env.BREVO_API_KEY;
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const express = require('express');
const session = require('express-session');
const database = require('../src/db/database');
const emailService = require('../src/services/emailService');
const proofGenerator = require('../src/services/proofGenerator');
const printRenderer = require('../src/services/printRenderer');
const partners = require('../src/services/partners');
const products = require('../src/services/products');

const GIFT_SKU = 'gift-11x14';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.stack || err.message}`);
  }
}

/** A tiny browser: one cookie jar, JSON in and out, redirects not followed. */
function browser(base) {
  let cookie = '';
  async function request(method, url, body) {
    const r = await fetch(`${base}${url}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* html */ }
    return { status: r.status, headers: r.headers, json, text };
  }
  return {
    get: (url) => request('GET', url),
    post: (url, body) => request('POST', url, body || {}),
  };
}

function orderBody(sku, extra = {}) {
  return {
    templateId: 'pet-tribute',
    sku,
    fields: { petName: 'Rookie', petType: 'Dog' },
    poemText: 'You knew the truck three streets away.',
    style: 'classic',
    layout: 'side-by-side',
    orderType: 'self',
    ...extra,
  };
}

/** Customize, proof, approve: what the designer does. */
async function placeGift(b, email) {
  const proof = await b.post('/api/checkout/proof', orderBody(GIFT_SKU));
  assert.strictEqual(proof.status, 200, `proof: ${proof.text}`);
  return b.post('/api/checkout', orderBody(GIFT_SKU, {
    orderId: proof.json.orderId, approved: true, ...(email ? { email } : {}),
  }));
}

(async () => {
  const db = await database.init();

  // Rendering is not under test here; which renderer runs is.
  const rendered = [];
  proofGenerator.generateProof = async (o) => ({ proofRelativeUrl: `/output/proofs/${o.id}.jpg` });
  proofGenerator.generateKeepsake = async (o) => {
    rendered.push({ kind: 'keepsake', id: o.id });
    return { keepsakeRelativeUrl: `/output/keepsakes/${o.id}.jpg` };
  };
  printRenderer.generatePrintFile = async (o) => {
    rendered.push({ kind: 'print', id: o.id });
    return { printRelativeUrl: `/output/print-ready/${o.id}.jpg` };
  };

  const sent = [];
  const capture = (name) => async (...args) => { sent.push({ name, args }); return { stubbed: true }; };
  emailService.sendGiftKeepsakeReceived = capture('received');
  emailService.sendGiftKeepsakeDelivery = capture('delivery');
  emailService.sendReviewRequest = capture('review');
  emailService.sendOrderConfirmation = capture('confirmation');
  emailService.sendDigitalDeliveryEmail = capture('digital');
  emailService.sendAdminAlert = capture('alert');

  const app = express();
  app.locals.db = db;
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  // Stands in for the photo upload, which keeps its record on the session.
  app.post('/test/photo', (req, res) => {
    req.session.photos = { photo: { path: 'photo.jpg' } };
    res.json({ ok: true });
  });
  app.use('/api', require('../src/routes/checkout'));
  app.use(require('../src/routes/partnerGift'));
  app.use('/api/admin', require('../src/routes/adminReview'));
  app.use('/api/templates', require('../src/routes/templates'));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const { partner } = partners.createPartner(db, { name: 'At Peace Pets', kind: 'home-euthanasia' });

  console.log('\nPartner gifts\n');

  // ── 1. The link.
  await check('slugs are made from the name and validated', async () => {
    assert.strictEqual(partner.slug, 'at-peace-pets');
    assert.strictEqual(partners.slugify('Hope & Paws Vet Clinic, St. Louis!'), 'hope-and-paws-vet-clinic-st-louis');
    assert.ok(partners.createPartner(db, { name: 'At Peace Pets' }).error, 'a taken slug is refused');
    assert.ok(partners.createPartner(db, { name: 'X', slug: 'Bad Slug' }).error, 'a malformed slug is refused');
  });

  await check('an unknown gift link is a kind 404', async () => {
    const r = await browser(base).get('/gift/nobody-here');
    assert.strictEqual(r.status, 404);
    assert.ok(/couldn’t find that gift link/.test(r.text));
  });

  await check('a gift link remembers the practice and opens the designer', async () => {
    const b = browser(base);
    const r = await b.get('/gift/at-peace-pets');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/customize/pet-tribute?from=at-peace-pets');
    const info = (await b.get('/api/partner-gift')).json;
    assert.strictEqual(info.partner.name, 'At Peace Pets');
    assert.strictEqual(info.available, true);
    assert.strictEqual(info.product.sku, GIFT_SKU);
    assert.strictEqual(info.product.price, 0);
  });

  await check('a visitor without a link is not in gift mode', async () => {
    const info = (await browser(base).get('/api/partner-gift')).json;
    assert.strictEqual(info.partner, null);
  });

  // ── 2. Placing a gift.
  await check('the free keepsake cannot be ordered without a gift link', async () => {
    const b = browser(base);
    await b.post('/test/photo');
    const r = await b.post('/api/checkout/proof', orderBody(GIFT_SKU));
    assert.strictEqual(r.status, 400);
    assert.ok(/gift link/.test(r.json.error));
  });

  let giftOrderId = null;
  await check('a gift needs an email, then is placed without Stripe', async () => {
    const b = browser(base);
    await b.get('/gift/at-peace-pets');
    await b.post('/test/photo');

    const noEmail = await placeGift(b, null);
    assert.strictEqual(noEmail.status, 400);
    assert.strictEqual(noEmail.json.code, 'email_required');

    // The same session's open order is reused, so this is the same row.
    const proof = await b.post('/api/checkout/proof', orderBody(GIFT_SKU));
    const r = await b.post('/api/checkout', orderBody(GIFT_SKU, {
      orderId: proof.json.orderId, approved: true, email: 'family@example.test',
    }));
    assert.strictEqual(r.status, 200, r.text);
    assert.ok(!r.json.checkoutUrl, 'no payment page');

    const o = db.get('SELECT * FROM orders WHERE id = ?', [proof.json.orderId]);
    giftOrderId = o.id;
    assert.strictEqual(r.json.redirectUrl, `/order/${o.proof_token}`);
    assert.strictEqual(o.status, 'awaiting_review', 'the shop still reviews it');
    assert.strictEqual(o.total_cents, 0);
    assert.strictEqual(o.partner_id, partner.id);
    assert.strictEqual(o.email, 'family@example.test');
    assert.strictEqual(o.stripe_session_id, null);
    assert.ok(o.proof_approved_at && o.proof_approved_url, 'their approval is on record');
    const ev = db.all('SELECT event_type FROM order_events WHERE order_id = ?', [o.id]).map(e => e.event_type);
    assert.ok(ev.includes('gift_placed') && ev.includes('proof_approved_inline'), ev.join(', '));

    const received = sent.find(s => s.name === 'received');
    assert.ok(received, 'the family is told we have it');
    assert.strictEqual(received.args[1].partnerName, 'At Peace Pets');
    assert.ok(!sent.some(s => s.name === 'confirmation'), 'not the paid order confirmation');
    const review = sent.find(s => s.name === 'review');
    assert.ok(review && review.args[1].isGift === true, 'the review email says it is a gift');
  });

  // ── 3. Limits.
  await check('one keepsake per email per practice', async () => {
    const b = browser(base);
    await b.get('/gift/at-peace-pets');
    await b.post('/test/photo');
    const r = await placeGift(b, 'FAMILY@example.test');
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'gift_already_sent');
  });

  await check('the monthly cap stops new keepsakes, kindly', async () => {
    partners.updatePartner(db, partner.id, { monthlyCap: 1 });
    const b = browser(base);
    await b.get('/gift/at-peace-pets');
    await b.post('/test/photo');
    assert.strictEqual((await b.get('/api/partner-gift')).json.reason, 'cap');
    const r = await placeGift(b, 'someone.else@example.test');
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.json.code, 'gift_unavailable');
    assert.ok(/At Peace Pets has given all of this month/.test(r.json.error));
    partners.updatePartner(db, partner.id, { monthlyCap: 30 });
  });

  await check('a paused link gives no keepsake', async () => {
    partners.updatePartner(db, partner.id, { active: false });
    const b = browser(base);
    await b.get('/gift/at-peace-pets');
    const info = (await b.get('/api/partner-gift')).json;
    assert.strictEqual(info.available, false);
    assert.strictEqual(info.reason, 'inactive');
    await b.post('/test/photo');
    const r = await placeGift(b, 'paused@example.test');
    assert.strictEqual(r.status, 409);
    partners.updatePartner(db, partner.id, { active: true });
  });

  // ── 4. Attribution of paid orders.
  await check('a framed order from the link is credited to the practice', async () => {
    const b = browser(base);
    await b.get('/gift/at-peace-pets');
    await b.post('/test/photo');
    const r = await b.post('/api/checkout/proof', orderBody('framed-11x14'));
    assert.strictEqual(r.status, 200, r.text);
    const o = db.get('SELECT partner_id, total_cents FROM orders WHERE id = ?', [r.json.orderId]);
    assert.strictEqual(o.partner_id, partner.id);
    assert.strictEqual(o.total_cents, 11900, 'full price');
  });

  await check('a framed order from the gift’s saved design, on another device, is credited too', async () => {
    db.run(
      `INSERT INTO saved_designs (token, template_id, state_json, order_id)
       VALUES ('11111111-2222-4333-8444-555555555555', 'pet-tribute', '{}', ?)`,
      [giftOrderId]
    );
    const b = browser(base);           // a fresh session: no link visited
    await b.post('/test/photo');
    const r = await b.post('/api/checkout/proof', orderBody('framed-8x10', {
      designToken: '11111111-2222-4333-8444-555555555555',
    }));
    assert.strictEqual(r.status, 200, r.text);
    assert.strictEqual(db.get('SELECT partner_id FROM orders WHERE id = ?', [r.json.orderId]).partner_id, partner.id);
  });

  await check('an ordinary visitor’s order has no partner', async () => {
    const b = browser(base);
    await b.post('/test/photo');
    const r = await b.post('/api/checkout/proof', orderBody('framed-11x14'));
    assert.strictEqual(db.get('SELECT partner_id FROM orders WHERE id = ?', [r.json.orderId]).partner_id, null);
  });

  // ── 5. Delivery.
  await check('approving a gift sends the screen keepsake, never the print file', async () => {
    const o = db.get('SELECT * FROM orders WHERE id = ?', [giftOrderId]);
    rendered.length = 0;
    const r = await browser(base).post(`/api/admin/review/${o.admin_token}/approve`);
    assert.strictEqual(r.status, 200, r.text);
    assert.deepStrictEqual(rendered.map(x => x.kind), ['keepsake']);

    const after = db.get('SELECT * FROM orders WHERE id = ?', [giftOrderId]);
    assert.strictEqual(after.status, 'delivered');
    assert.strictEqual(after.print_file_url, `/output/keepsakes/${giftOrderId}.jpg`);
    const ev = db.all('SELECT event_type FROM order_events WHERE order_id = ?', [giftOrderId]).map(e => e.event_type);
    assert.ok(!ev.includes('upgrade_credit_created') && !ev.includes('upgrade_credit_failed'), 'no credit for a gift');

    const delivery = sent.find(s => s.name === 'delivery');
    assert.ok(delivery, 'gift delivery email sent');
    assert.ok(!sent.some(s => s.name === 'digital'), 'not the paid keepsake email');
    const [, data, links] = delivery.args;
    assert.strictEqual(data.partnerName, 'At Peace Pets');
    assert.strictEqual(data.framedFromCents, 7900);
    assert.strictEqual(links.frameUrl,
      'https://example.test/customize/pet-tribute?design=11111111-2222-4333-8444-555555555555&frame=1');
    assert.strictEqual(links.downloadUrl, `https://example.test/download/${after.proof_token}`);
  });

  // ── 6. What the gift is, and is not.
  await check('the gift is a digital order, but not something the shop sells', async () => {
    const giftOrder = db.get('SELECT * FROM orders WHERE id = ?', [giftOrderId]);
    assert.strictEqual(products.isDigitalOrder(giftOrder), true);
    assert.strictEqual(products.isGiftOrder(giftOrder), true);
    const template = products.loadTemplate('pet-tribute');
    assert.ok(!template.printProducts.some(p => p.sku === GIFT_SKU));
    const list = (await browser(base).get('/api/templates')).json;
    const pet = list.find(t => t.id === 'pet-tribute');
    assert.ok(pet.startingPrice > 0, `startingPrice is ${pet.startingPrice}`);
  });

  await check('the partner list counts keepsakes and paid orders separately', async () => {
    db.run(`UPDATE orders SET status = 'awaiting_review' WHERE partner_id = ? AND product_sku != ?`, [partner.id, GIFT_SKU]);
    const row = partners.listWithStats(db, GIFT_SKU).find(p => p.id === partner.id);
    assert.strictEqual(row.giftsGiven, 1);
    assert.strictEqual(row.paidOrders, 2);
    assert.strictEqual(row.paidCents, 11900 + 7900);
  });

  await check('the printable card is a 4x6 PNG at 300 DPI', async () => {
    const sharp = require('sharp');
    const png = await require('../src/services/partnerCard').renderPartnerCard(partner);
    const meta = await sharp(png).metadata();
    assert.strictEqual(meta.format, 'png');
    assert.strictEqual(meta.width, 1200);
    assert.strictEqual(meta.height, 1800);
  });

  server.close();
  database.flush();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
  process.exitCode = failures ? 1 : 0;
})().catch(err => {
  console.error(err);
  process.exit(1);
});
