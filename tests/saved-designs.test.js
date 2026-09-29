/**
 * Saved designs ("Email me my design"), end to end, against a real (temporary)
 * database, real sessions, the real upload and proof routes.
 *
 * What has to be true before this goes live:
 *
 *   1. A design saved on one device reopens on ANOTHER (a fresh session), and
 *      that second device can render the real proof, because restoring the
 *      design re-attaches the photo to the new session. This is the whole
 *      point, and it is what the old tab-only state could never do.
 *   2. The saved-design email goes out once per address, carries a link that
 *      reopens this design, and the API never hands out the stored email.
 *   3. Bad input is refused; expired designs are gone; the stop switch works
 *      and a mail scanner following the GET link cannot press it.
 *   4. The reminder engine sends exactly one reminder, only 2-14 days after
 *      the save, never to someone who ordered or said stop, and never logs a
 *      send that did not happen.
 *   5. The abandoned-checkout email links to the saved design when one exists.
 *
 *   node tests/saved-designs.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Environment BEFORE any module under test loads: they read it at require time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbm-saved-designs-test-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.UPLOADS_DIR = path.join(TMP, 'uploads');
process.env.OUTPUT_DIR = path.join(TMP, 'output');
process.env.BASE_URL = 'https://example.test';
process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_not_a_real_secret';
delete process.env.SMTP_HOST;
process.env.DESIGN_REMINDERS_ENABLED = 'true';
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const express = require('express');
const session = require('express-session');
const sharp = require('sharp');
const Stripe = require('stripe');
const database = require('../src/db/database');
const emailService = require('../src/services/emailService');
const designReminderEngine = require('../src/services/designReminderEngine');

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

/** A browser: remembers its own session cookie across requests. */
function device(base) {
  let cookie = '';
  const remember = (r) => {
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return r;
  };
  return {
    async json(method, p, body) {
      const r = remember(await fetch(`${base}${p}`, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }));
      return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
    },
    async raw(method, p, init = {}) {
      return remember(await fetch(`${base}${p}`, {
        method, ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) },
      }));
    },
    async upload(buffer) {
      const form = new FormData();
      form.append('slotId', 'main');
      form.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'rex.jpg');
      const r = remember(await fetch(`${base}/api/images/upload`, {
        method: 'POST', body: form, headers: cookie ? { cookie } : {},
      }));
      return { status: r.status, body: await r.json().catch(() => ({})) };
    },
  };
}

/** What the designer would send: its own state object, as saveState keeps it. */
function designerState(overrides = {}) {
  return {
    templateId: 'pet-tribute',
    fields: { petName: 'Rex', petType: 'Dog', poemText: 'You were the best of us.\nStill beside me.' },
    style: 'classic-dark',
    layout: 'side-by-side',
    photos: { photo: { slotId: 'main', url: '/uploads/placeholder.jpg', position: '50% 50%' } },
    selectedSku: 'framed-11x14',
    timestamp: Date.now(),
    ...overrides,
  };
}

/** What the order button posts to /api/checkout/proof. */
function proofBody() {
  return {
    templateId: 'pet-tribute',
    sku: 'framed-11x14',
    fields: { petName: 'Rex', petType: 'Dog' },
    poemText: 'You were the best of us.\nStill beside me.',
    style: 'classic-dark',
    layout: 'side-by-side',
    orderType: 'self',
  };
}

(async () => {
  const db = await database.init();

  // Emails are captured, never sent. A messageId is what a real send returns.
  const sent = [];
  let noSmtpFor = null;
  emailService.sendDesignSaved = async (to, d) => { sent.push({ kind: 'saved', to, d }); return { messageId: `m${sent.length}` }; };
  emailService.sendDesignReminder = async (to, d) => {
    sent.push({ kind: 'reminder', to, d });
    return to === noSmtpFor ? { preview: true } : { messageId: `m${sent.length}` };
  };
  emailService.sendAbandonedCheckoutRecovery = async (to, d, resumeUrl) => { sent.push({ kind: 'recovery', to, d, resumeUrl }); return { messageId: 'r' }; };
  emailService.sendAdminAlert = async () => ({ stubbed: true });

  const app = express();
  app.locals.db = db;
  app.use('/api/stripe-webhooks', express.raw({ type: 'application/json' }));
  app.use('/api/stripe-webhooks', require('../src/routes/stripeWebhooks'));
  app.use(express.json({ limit: '5mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: true }));
  app.use('/api', require('../src/routes/api'));
  app.use('/api', require('../src/routes/checkout'));
  app.use(require('../src/routes/designs'));
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const photo = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#8B7355' } })
    .jpeg().toBuffer();

  console.log('\nSaved designs\n');

  // ── 1. Save on one device, reopen and proof on another ─────────────────
  const laptop = device(base);
  const phone = device(base);
  let token = null;

  await check('a design with a photo saves quietly (no email asked, none sent)', async () => {
    const up = await laptop.upload(photo);
    assert.strictEqual(up.status, 200, JSON.stringify(up.body));
    const r = await laptop.json('POST', '/api/designs', { templateId: 'pet-tribute', state: designerState() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body, { saved: true, emailed: false });
    assert.strictEqual(sent.length, 0);
    const row = db.get('SELECT * FROM saved_designs');
    assert.ok(row && row.token && !row.email);
    assert.ok(JSON.parse(row.photos_json).main.originalPath, 'the server photo record is kept');
    token = row.token;
  });

  await check('asking by email sends one email whose link reopens THIS design', async () => {
    const r = await laptop.json('POST', '/api/designs', {
      templateId: 'pet-tribute', state: designerState(), email: ' Family@Example.test ',
    });
    assert.deepStrictEqual(r.body, { saved: true, emailed: true });
    assert.strictEqual(sent.length, 1);
    const e = sent[0];
    assert.strictEqual(e.to, 'family@example.test');
    assert.strictEqual(e.d.petName, 'Rex');
    assert.strictEqual(e.d.resumeUrl, `https://example.test/customize/pet-tribute?design=${token}`);
    assert.strictEqual(e.d.photoUrl, `https://example.test/d/${token}/photo`);
    assert.strictEqual(e.d.stopUrl, `https://example.test/d/${token}/stop`);
    assert.strictEqual(e.d.remindersOn, true, 'reminders are on, so the email says one follows');
    const saved = db.get('SELECT saved_email_sent_at, reminders_off FROM saved_designs WHERE token = ?', [token]);
    assert.ok(saved.saved_email_sent_at);
    assert.strictEqual(saved.reminders_off, 0);
  });

  await check('a design saved while reminders are OFF is promised none, and keeps that promise', async () => {
    process.env.DESIGN_REMINDERS_ENABLED = 'false';
    try {
      const quiet = device(base);
      await quiet.upload(photo);
      const r = await quiet.json('POST', '/api/designs', {
        templateId: 'pet-tribute', state: designerState(), email: 'quiet@example.test',
      });
      assert.deepStrictEqual(r.body, { saved: true, emailed: true });
      const e = sent[sent.length - 1];
      assert.strictEqual(e.to, 'quiet@example.test');
      assert.strictEqual(e.d.remindersOn, false, 'the email must not promise a reminder while they are switched off');
      const row = db.get(`SELECT reminders_off FROM saved_designs WHERE email = 'quiet@example.test'`);
      assert.strictEqual(row.reminders_off, 1, 'recorded on the row, so switching reminders on later cannot break the promise');
      // Asking again once reminders are on is fresh consent for one.
      process.env.DESIGN_REMINDERS_ENABLED = 'true';
      await quiet.json('POST', '/api/designs', {
        templateId: 'pet-tribute', state: designerState(), email: 'quiet2@example.test',
      });
      assert.strictEqual(db.get(`SELECT reminders_off FROM saved_designs WHERE email = 'quiet2@example.test'`).reminders_off, 0);
      db.run(`DELETE FROM saved_designs WHERE email = 'quiet2@example.test'`);
      sent.length = 1;
    } finally {
      process.env.DESIGN_REMINDERS_ENABLED = 'true';
    }
  });

  await check('pressing it again with the same address sends nothing more', async () => {
    const r = await laptop.json('POST', '/api/designs', {
      templateId: 'pet-tribute', state: designerState(), email: 'family@example.test',
    });
    assert.deepStrictEqual(r.body, { saved: true, emailed: true });
    assert.strictEqual(sent.length, 1);
  });

  await check('later saves from the same visitor update one design, not many', async () => {
    await laptop.json('POST', '/api/designs', {
      templateId: 'pet-tribute', state: designerState({ layout: 'stacked' }),
    });
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM saved_designs').n, 1);
    assert.strictEqual(JSON.parse(db.get('SELECT state_json FROM saved_designs').state_json).layout, 'stacked');
  });

  await check('a second device cannot render a proof on its own (no photo in its session)', async () => {
    const r = await phone.json('POST', '/api/checkout/proof', proofBody());
    assert.strictEqual(r.status, 400);
  });

  await check('opening the link on the second device returns the design and never the email', async () => {
    const r = await phone.json('GET', `/api/designs/${token}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.templateId, 'pet-tribute');
    assert.strictEqual(r.body.state.layout, 'stacked');
    assert.ok(!JSON.stringify(r.body).includes('family@example.test'), 'email leaked');
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  });

  await check('...and that second device can now render the real proof', async () => {
    const r = await phone.json('POST', '/api/checkout/proof', proofBody());
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.orderId && r.body.proofUrl);
  });

  await check('a reopened page whose session LOST the photo still proofs, by naming its design', async () => {
    // What a lost session write looks like: a device that holds the design's
    // token (from the link) but whose session never kept the photo record.
    const tablet = device(base);
    assert.strictEqual((await tablet.json('POST', '/api/checkout/proof', proofBody())).status, 400);
    const r = await tablet.json('POST', '/api/checkout/proof', { ...proofBody(), designToken: token });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    // ...and the session is healed, so the payment step sees the same photo.
    const again = await tablet.json('POST', '/api/checkout/proof', proofBody());
    assert.strictEqual(again.status, 200, JSON.stringify(again.body));
  });

  await check('an unknown design token lends no photo', async () => {
    const v = device(base);
    const r = await v.json('POST', '/api/checkout/proof', {
      ...proofBody(), designToken: '00000000-0000-4000-8000-000000000000',
    });
    assert.strictEqual(r.status, 400);
  });

  await check('a save from a session that lost its note updates the SAME design, not a photo-less copy', async () => {
    const before = db.get('SELECT COUNT(*) AS n FROM saved_designs').n;
    const forgetful = device(base);
    const r = await forgetful.json('POST', '/api/designs', {
      templateId: 'pet-tribute', state: designerState({ layout: 'portrait' }), designToken: token,
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM saved_designs').n, before);
    const row = db.get('SELECT state_json, photos_json FROM saved_designs WHERE token = ?', [token]);
    assert.strictEqual(JSON.parse(row.state_json).layout, 'portrait');
    assert.ok(JSON.parse(row.photos_json).main, 'the photo record is kept');
  });

  await check('the proof step links its draft order to the design (own session only)', async () => {
    const draft = db.get(`SELECT id FROM orders WHERE status = 'draft'`);
    // A stranger's session naming that order links nothing.
    const stranger = device(base);
    await stranger.upload(photo);
    await stranger.json('POST', '/api/designs', { templateId: 'pet-tribute', state: designerState(), orderId: draft.id });
    const strangerRow = db.get('SELECT order_id FROM saved_designs WHERE token != ? ORDER BY id DESC LIMIT 1', [token]);
    assert.strictEqual(strangerRow.order_id, null);
    // The phone, which opened the link, updates the SAME design and links it.
    await phone.json('POST', '/api/designs', { templateId: 'pet-tribute', state: designerState(), orderId: draft.id });
    assert.strictEqual(db.get('SELECT order_id FROM saved_designs WHERE token = ?', [token]).order_id, draft.id);
  });

  await check('the email photo is served by token, and nothing else is', async () => {
    const ok = await fetch(`${base}/d/${token}/photo`);
    assert.strictEqual(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /image\/jpeg/);
    assert.strictEqual((await fetch(`${base}/d/00000000-0000-4000-8000-000000000000/photo`)).status, 404);
    assert.strictEqual((await fetch(`${base}/d/not-a-token/photo`)).status, 404);
  });

  // ── 2. Refusals ────────────────────────────────────────────────────────
  await check('bad input is refused', async () => {
    const v = device(base);
    const bad = async (body, status) => {
      const r = await v.json('POST', '/api/designs', body);
      assert.strictEqual(r.status, status, `${JSON.stringify(body).slice(0, 80)} -> ${r.status}`);
    };
    await bad({ templateId: 'no-such-template', state: designerState({ templateId: 'no-such-template' }) }, 400);
    await bad({ templateId: '../../etc', state: designerState({ templateId: '../../etc' }) }, 400);
    await bad({ templateId: 'pet-tribute', state: designerState({ templateId: 'other' }) }, 400);
    await bad({ templateId: 'pet-tribute', state: [] }, 400);
    await bad({ templateId: 'pet-tribute', state: designerState(), email: 'not-an-email' }, 400);
    await bad({ templateId: 'pet-tribute', state: designerState({ padding: 'x'.repeat(300 * 1024) }) }, 413);
    assert.strictEqual(sent.length, 1, 'no refused request sends an email');
  });

  await check('an unknown design is 404, an expired one is 410 and restores nothing', async () => {
    const v = device(base);
    assert.strictEqual((await v.json('GET', '/api/designs/00000000-0000-4000-8000-000000000000')).status, 404);
    assert.strictEqual((await v.json('GET', '/api/designs/nonsense')).status, 404);
    db.run(`INSERT INTO saved_designs (token, template_id, state_json, expires_at)
            VALUES ('11111111-1111-4111-8111-111111111111', 'pet-tribute', '{}', datetime('now', '-1 day'))`);
    const r = await v.json('GET', '/api/designs/11111111-1111-4111-8111-111111111111');
    assert.strictEqual(r.status, 410);
    assert.strictEqual(r.body.code, 'expired');
    assert.ok(!r.body.state);
  });

  await check('the stop page asks first; only the POST switches reminders off', async () => {
    const page = await fetch(`${base}/d/${token}/stop`);
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /<form method="POST"/);
    assert.strictEqual(db.get('SELECT reminders_off FROM saved_designs WHERE token = ?', [token]).reminders_off, 0);
    const done = await fetch(`${base}/d/${token}/stop`, { method: 'POST' });
    assert.strictEqual(done.status, 200);
    assert.strictEqual(db.get('SELECT reminders_off FROM saved_designs WHERE token = ?', [token]).reminders_off, 1);
  });

  // ── 3. The reminder engine ─────────────────────────────────────────────
  db.run('DELETE FROM saved_designs');
  const addDesign = (name, { email = `${name}@example.test`, savedDaysAgo, off = 0, orderId = null, emailed = true }) => {
    db.run(
      `INSERT INTO saved_designs (token, template_id, email, pet_name, state_json, order_id,
                                  saved_email_sent_at, reminders_off, created_at)
       VALUES (?, 'pet-tribute', ?, 'Rex', '{}', ?, ${emailed ? `datetime('now', '-${savedDaysAgo} days')` : 'NULL'}, ?,
               datetime('now', '-${savedDaysAgo} days'))`,
      [`${name}-0000-4000-8000-000000000000`.slice(0, 36), email, orderId, off]
    );
  };
  addDesign('due00000', { savedDaysAgo: 3 });
  addDesign('soon0000', { savedDaysAgo: 1 });
  addDesign('old00000', { savedDaysAgo: 20 });
  addDesign('stop0000', { savedDaysAgo: 3, off: 1 });
  addDesign('noemail0', { savedDaysAgo: 3, emailed: false });
  db.run(`INSERT INTO orders (id, status, template_id, total_cents) VALUES ('paid-linked', 'awaiting_review', 'pet-tribute', 100)`);
  addDesign('linked00', { savedDaysAgo: 3, orderId: 'paid-linked' });
  db.run(`INSERT INTO orders (id, status, template_id, total_cents, email, created_at)
          VALUES ('paid-later', 'shipped', 'pet-tribute', 100, 'buyer@example.test', datetime('now'))`);
  addDesign('buyer000', { email: 'buyer@example.test', savedDaysAgo: 3 });
  db.run(`INSERT INTO orders (id, status, template_id, total_cents) VALUES ('abandoned', 'cancelled', 'pet-tribute', 100)`);
  addDesign('abandon0', { savedDaysAgo: 3, orderId: 'abandoned' });
  addDesign('preview0', { savedDaysAgo: 3 });

  await check('reminders go only to saves 2-14 days old, not stopped, not ordered', async () => {
    noSmtpFor = 'preview0@example.test';
    sent.length = 0;
    const r = await designReminderEngine.checkAndSend();
    const to = sent.filter(s => s.kind === 'reminder').map(s => s.to).sort();
    assert.deepStrictEqual(to, ['abandon0@example.test', 'due00000@example.test', 'preview0@example.test']);
    assert.deepStrictEqual(r, { sent: 2, skipped: 2, failed: 1 });
    const reminded = db.all('SELECT email FROM saved_designs WHERE reminder_sent_at IS NOT NULL').map(x => x.email).sort();
    assert.deepStrictEqual(reminded, ['abandon0@example.test', 'due00000@example.test'], 'a no-SMTP preview is not logged');
    const d = sent.find(s => s.to === 'due00000@example.test').d;
    assert.match(d.resumeUrl, /\?design=due00000-/);
    assert.match(d.stopUrl, /\/d\/due00000-.*\/stop$/);
  });

  await check('a second run sends nothing already sent (one reminder, ever)', async () => {
    noSmtpFor = null;
    sent.length = 0;
    await designReminderEngine.checkAndSend();
    assert.deepStrictEqual(sent.map(s => s.to), ['preview0@example.test'], 'only the one that never really went out is retried');
    sent.length = 0;
    await designReminderEngine.checkAndSend();
    assert.strictEqual(sent.length, 0);
  });

  await check('expired designs are purged', async () => {
    db.run(`UPDATE saved_designs SET expires_at = datetime('now', '-1 minute') WHERE email = 'old00000@example.test'`);
    const n = await designReminderEngine.purgeExpired();
    assert.strictEqual(n, 1);
    assert.ok(!db.get(`SELECT 1 FROM saved_designs WHERE email = 'old00000@example.test'`));
  });

  // ── 4. Abandoned checkout points at the design ─────────────────────────
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const expire = async (orderId) => {
    db.run(
      `INSERT INTO orders (id, status, template_id, product_sku, total_cents, stripe_session_id, fields_json)
       VALUES (?, 'pending_payment', 'pet-tribute', 'framed-11x14', 100, ?, '{"petName":"Rex"}')`,
      [orderId, `cs_${orderId}`]
    );
    const payload = JSON.stringify({ id: `evt_${orderId}`, object: 'event', type: 'checkout.session.expired',
      data: { object: { id: `cs_${orderId}`, object: 'checkout.session', metadata: { orderId },
        customer_details: { email: 'left@example.test' } } } });
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: process.env.STRIPE_WEBHOOK_SECRET });
    await fetch(`${base}/api/stripe-webhooks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'stripe-signature': header }, body: payload,
    });
    return sent.find(s => s.kind === 'recovery' && s.to === 'left@example.test' && s.orderId !== 'seen');
  };

  await check('the abandoned-checkout email reopens the saved design when there is one', async () => {
    sent.length = 0;
    db.run(`INSERT INTO saved_designs (token, template_id, state_json, order_id)
            VALUES ('22222222-2222-4222-8222-222222222222', 'pet-tribute', '{}', 'with-design')`);
    const e = await expire('with-design');
    assert.ok(e, 'recovery email sent');
    assert.strictEqual(e.resumeUrl, 'https://example.test/customize/pet-tribute?design=22222222-2222-4222-8222-222222222222');
  });

  await check('...and falls back to the designer when there is none', async () => {
    sent.length = 0;
    const e = await expire('without-design');
    assert.ok(e, 'recovery email sent');
    assert.strictEqual(e.resumeUrl, 'https://example.test/customize/pet-tribute');
  });

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures) {
    console.error(`\n${failures} saved-design check(s) failed\n`);
    process.exit(1);
  }
  console.log('\nAll saved-design checks passed\n');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
