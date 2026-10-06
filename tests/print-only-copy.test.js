/**
 * A print-only order must never be told it is framed.
 *
 * This exists because of a real shipping email. Order 2A47ADF9 was the first
 * unframed 11x14 print, bare paper for the customer's own frame, and the
 * shipped email told them "Your framed tribute has shipped." Every customer
 * message had been written when a framed tribute was the only thing we sold.
 *
 * The real emails are rendered here with delivery swapped for a capture, so the
 * test reads exactly what a customer would.
 *
 *   node tests/print-only-copy.test.js
 */

const assert = require('assert');

// Capture outgoing mail instead of sending it. Set before emailService loads.
process.env.SMTP_HOST = 'smtp.test.invalid';
delete process.env.ADMIN_EMAIL;
const sent = [];
const nodemailer = require('nodemailer');
nodemailer.createTransport = () => ({
  sendMail: async (opts) => { sent.push(opts); return { messageId: 'test' }; },
});

const emailService = require('../src/services/emailService');
const { buildTimeline } = require('../src/routes/orderStatus');

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

const ORDER_ID = '2a47adf9-0d5d-419b-ac99-9f4b34b42640';
const tracking = { number: '9400100000000000000000', carrier: 'USPS', url: null };

async function render(fn) {
  sent.length = 0;
  await fn();
  assert.strictEqual(sent.length, 1, 'expected exactly one email');
  return sent[0].html;
}

(async () => {
  console.log('\nShipped email:');

  await check('print-only order is not called framed', async () => {
    const html = await render(() => emailService.sendShippedEmail(
      'a@example.com', { orderId: ORDER_ID, sku: 'print-11x14' }, tracking, null));
    assert(!/fram/i.test(html), 'print-only shipped email mentions a frame');
    assert(html.includes('Your tribute print has shipped'));
  });

  await check('framed order still says framed tribute', async () => {
    const html = await render(() => emailService.sendShippedEmail(
      'a@example.com', { orderId: ORDER_ID, sku: 'framed-11x14' }, tracking, null));
    assert(html.includes('Your framed tribute has shipped'));
  });

  console.log('\nBeing-printed email:');

  await check('print-only order is not promised framing', async () => {
    const html = await render(() => emailService.sendApprovalConfirmation(
      'a@example.com', { orderId: ORDER_ID, totalCents: 3900, sku: 'print-11x14' },
      null, 'https://example.com/note.jpg'));
    assert(!/professionally framed|with the frame|framed tribute/i.test(html),
      'print-only confirmation promises a frame');
    assert(html.includes('archival fine art paper'));
  });

  await check('framed order still says professionally framed', async () => {
    const html = await render(() => emailService.sendApprovalConfirmation(
      'a@example.com', { orderId: ORDER_ID, totalCents: 11900, sku: 'framed-11x14' }, null));
    assert(html.includes('professionally framed'));
  });

  console.log('\nStatus page:');

  const base = {
    id: ORDER_ID, status: 'shipped',
    created_at: '2026-10-04 10:00:00', proof_approved_at: '2026-10-04 10:05:00',
  };
  const events = [
    { event_type: 'order_created', created_at: '2026-10-04 10:00:00' },
    { event_type: 'proof_approved_inline', created_at: '2026-10-04 10:05:00' },
    { event_type: 'payment_confirmed', created_at: '2026-10-04 10:06:00' },
    { event_type: 'luma_submitted', created_at: '2026-10-05 09:00:00' },
    { event_type: 'partner_shipped', created_at: '2026-10-06 09:00:00' },
  ];

  await check('print-only timeline never says framing', () => {
    const text = JSON.stringify(buildTimeline({ ...base, product_sku: 'print-11x14' }, events));
    assert(!/fram/i.test(text), 'print-only timeline mentions framing');
  });

  await check('framed timeline still says framing', () => {
    const text = JSON.stringify(buildTimeline({ ...base, product_sku: 'framed-11x14' }, events));
    assert(/Printing and framing/.test(text));
  });

  if (failures) {
    console.error(`\n${failures} check(s) failed\n`);
    process.exit(1);
  }
  console.log('\nAll print-only copy checks passed\n');
})();
