/**
 * The doors that move money or orders must stay shut to strangers.
 *
 *   1. /api/whcc and /api/whcc-editor are operator tools (they submit orders
 *      to the lab, repoint its webhooks, write the product map). Until Sept
 *      2026 both answered anyone on the internet. They now sit behind the
 *      admin session, exactly like /api/luma.
 *   2. The Luma shipping webhook is unsigned. With LUMA_WEBHOOK_TOKEN set it
 *      answers only at /api/luma-webhooks/<token>; the bare path and a wrong
 *      token look like nothing is there (404). Unset, only the bare path works,
 *      which is how it behaved before the token existed.
 *
 * Runs the real routers on a throwaway port.
 *
 *   node tests/route-guards.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbm-route-guards-test-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.ADMIN_PASSWORD = 'test-admin-password';
delete process.env.LUMA_WEBHOOK_TOKEN;
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const express = require('express');
const database = require('../src/db/database');
const lumaWebhooks = require('../src/routes/lumaWebhooks');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

(async () => {
  const db = await database.init();

  const app = express();
  app.locals.db = db;
  // Stand-in for express-session: a request is signed in when it says so.
  app.use((req, res, next) => {
    req.session = { isAdmin: req.get('x-test-admin') === 'yes' };
    next();
  });
  app.use(express.json());
  app.use('/api/whcc', require('../src/routes/whcc'));
  app.use('/api/whcc-editor', require('../src/routes/whccEditor'));
  app.use('/api/luma-webhooks', express.raw({ type: 'application/json' }));
  app.use('/api/luma-webhooks', lumaWebhooks);

  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (method, p, { admin = false, body } = {}) => fetch(`${base}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(admin ? { 'x-test-admin': 'yes' } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  console.log('\nRoute guards\n');

  // ── 1. WHCC operator routes.
  const operatorRoutes = [
    ['GET', '/api/whcc/health'],
    ['GET', '/api/whcc/product-map'],
    ['POST', '/api/whcc/product-map'],
    ['POST', '/api/whcc/test-order'],
    ['POST', '/api/whcc/orders/some-order/submit'],
    ['POST', '/api/whcc/webhook/register'],
    ['GET', '/api/whcc-editor/health'],
    ['POST', '/api/whcc-editor/session'],
    ['POST', '/api/whcc-editor/order/create'],
    ['POST', '/api/whcc-editor/order/some-order/confirm'],
  ];
  for (const [method, p] of operatorRoutes) {
    await check(`${method} ${p} refuses a stranger with 401`, async () => {
      const r = await req(method, p, { body: method === 'POST' ? {} : undefined });
      assert.strictEqual(r.status, 401);
    });
  }

  await check('a signed-in admin gets through', async () => {
    const r = await req('GET', '/api/whcc/product-map', { admin: true });
    assert.strictEqual(r.status, 200);
    assert.ok('mappings' in await r.json());
  });

  await check('with ADMIN_PASSWORD unset the routes are closed, not open', async () => {
    const saved = process.env.ADMIN_PASSWORD;
    delete process.env.ADMIN_PASSWORD;
    try {
      const r = await req('GET', '/api/whcc/product-map', { admin: true });
      assert.strictEqual(r.status, 503);
    } finally {
      process.env.ADMIN_PASSWORD = saved;
    }
  });

  // ── 2. Luma webhook token. An unknown order number is used throughout, so
  // an accepted POST answers 200 with a warning and touches nothing.
  const shipped = { orderNumber: 'no-such-order', shipments: [] };

  await check('no token configured: the bare path answers, as before', async () => {
    assert.strictEqual((await req('GET', '/api/luma-webhooks')).status, 200);
    assert.strictEqual((await req('POST', '/api/luma-webhooks', { body: shipped })).status, 200);
    assert.strictEqual(lumaWebhooks.webhookPath(), '/api/luma-webhooks');
  });

  await check('no token configured: a tokened path does not exist', async () => {
    assert.strictEqual((await req('POST', '/api/luma-webhooks/guess', { body: shipped })).status, 404);
  });

  process.env.LUMA_WEBHOOK_TOKEN = 'a-long-secret-token';

  await check('token configured: the bare path goes dark', async () => {
    assert.strictEqual((await req('GET', '/api/luma-webhooks')).status, 404);
    assert.strictEqual((await req('POST', '/api/luma-webhooks', { body: shipped })).status, 404);
  });

  await check('token configured: a wrong token is refused', async () => {
    assert.strictEqual((await req('POST', '/api/luma-webhooks/a-long-secret-tokeX', { body: shipped })).status, 404);
  });

  await check('token configured: the right token is accepted', async () => {
    assert.strictEqual((await req('GET', '/api/luma-webhooks/a-long-secret-token')).status, 200);
    assert.strictEqual((await req('POST', '/api/luma-webhooks/a-long-secret-token', { body: shipped })).status, 200);
  });

  await check('the registration helper hands Luma the tokened URL', async () => {
    assert.strictEqual(lumaWebhooks.webhookPath(), '/api/luma-webhooks/a-long-secret-token');
  });

  delete process.env.LUMA_WEBHOOK_TOKEN;

  server.close();
  database.flush();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
  process.exitCode = failures ? 1 : 0;
})().catch(err => {
  console.error(err);
  process.exit(1);
});
