/**
 * The WHCC webhook can move an order to in_production, cancelled or shipped,
 * so it must only act on events WHCC really signed. It used to skip the check
 * entirely whenever WHCC_CONSUMER_SECRET was unset; it now refuses instead.
 *
 * Shared by every brand on this platform; keep the copies identical.
 *
 *   node tests/whcc-webhook-signature.test.js
 */

const assert = require('assert');
const crypto = require('crypto');
const express = require('express');

delete process.env.WHCC_CONSUMER_SECRET;
const router = require('../src/routes/whccWebhooks');

// Unknown confirmation id: an accepted event answers 200 and touches nothing.
const fakeDb = { get() { return undefined; }, run() {}, all() { return []; } };
const EVENT = JSON.stringify({ ConfirmationId: 'no-such-order', Event: 'Shipped' });

function sign(secret, body, t = '1591735205') {
  const v1 = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex').toUpperCase();
  return `t=${t},v1=${v1}`;
}

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
  const app = express();
  app.locals.db = fakeDb;
  app.use('/api/whcc-webhooks', express.raw({ type: '*/*' }));
  app.use('/api/whcc-webhooks', router);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/api/whcc-webhooks/callback`;
  const post = (headers = {}) => fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: EVENT,
  });

  console.log('\nWHCC webhook signature\n');

  await check('no secret configured: every event is refused', async () => {
    assert.strictEqual((await post()).status, 401);
    assert.strictEqual((await post({ 'whcc-signature': sign('anything', EVENT) })).status, 401);
  });

  process.env.WHCC_CONSUMER_SECRET = 'test-consumer-secret';

  await check('secret configured: an unsigned event is refused', async () => {
    assert.strictEqual((await post()).status, 401);
  });

  await check('secret configured: a wrongly signed event is refused', async () => {
    assert.strictEqual((await post({ 'whcc-signature': sign('wrong-secret', EVENT) })).status, 401);
  });

  await check('secret configured: a correctly signed event is accepted', async () => {
    assert.strictEqual((await post({ 'whcc-signature': sign('test-consumer-secret', EVENT) })).status, 200);
  });

  delete process.env.WHCC_CONSUMER_SECRET;
  server.close();
  console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
  process.exitCode = failures ? 1 : 0;
})().catch(err => {
  console.error(err);
  process.exit(1);
});
