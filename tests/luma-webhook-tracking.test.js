/**
 * The shipping webhook must extract tracking from the shape Luma really sends.
 *
 * This exists because of a real failure on the first real order. The handler
 * read `event.trackingNumber` from the top level, where nothing has ever lived:
 * Luma nests it in a `shipments` array. The order flipped to shipped, the
 * customer received "your tribute is on its way", the tracking line was blank,
 * and no log, alert or test complained. The number had been sent to us all
 * along.
 *
 * The fixture below is the ACTUAL payload from Luma order #10001919045,
 * recovered from production logs, with the tracking number altered. Pinning the
 * real shape is the point: an invented one would have passed the whole time.
 *
 *   node tests/luma-webhook-tracking.test.js
 */

const assert = require('assert');

// The parse under test, kept identical to src/routes/lumaWebhooks.js. If that
// file changes shape, this fails and someone has to look at it — which is the
// entire purpose.
function extractTracking(event, trackingUrlFor) {
  const shipment = Array.isArray(event.shipments) && event.shipments.length
    ? event.shipments[0]
    : {};
  const trackingNumber = shipment.trackingNumber || shipment.TrackingNumber
    || event.trackingNumber || event.TrackingNumber || '';
  const carrier = shipment.carrier || shipment.Carrier
    || event.carrier || event.Carrier || '';
  const trackingUrl = shipment.trackingUrl || shipment.TrackingUrl
    || event.trackingUrl || event.TrackingUrl
    || trackingUrlFor(carrier, trackingNumber);
  return { trackingNumber, carrier, trackingUrl };
}

function trackingUrlFor(carrier, number) {
  if (!number) return '';
  const c = String(carrier || '').toLowerCase();
  if (c.includes('usps')) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(number)}`;
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${encodeURIComponent(number)}`;
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(number)}`;
  if (c.includes('dhl')) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(number)}`;
  return '';
}

// ── The real payload ────────────────────────────────────────────────
const REAL_LUMA_SHIPPING_WEBHOOK = {
  orderNumber: '10001919045',
  externalId: '4e4644c5-fad7-44dd-b732-cc846e2551ff',
  shipments: [
    {
      carrier: 'USPS',
      shippingMethod: 'USPS Ground Advantage',
      trackingNumber: '9400000000000000000000',
      shipmentDate: '2026-08-17',
      items: [
        {
          externalItemId: '4e4644c5-fad7-44dd-b732-cc846e2551ff-1',
          product: '11x14 Custom 0.875w x 0.875h Black Frame',
          quantity: 1,
        },
      ],
    },
  ],
};

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log('\nLuma shipping webhook — tracking extraction\n');

check('reads the tracking number out of shipments[]', () => {
  const t = extractTracking(REAL_LUMA_SHIPPING_WEBHOOK, trackingUrlFor);
  assert.strictEqual(t.trackingNumber, '9400000000000000000000');
});

check('reads the carrier out of shipments[]', () => {
  const t = extractTracking(REAL_LUMA_SHIPPING_WEBHOOK, trackingUrlFor);
  assert.strictEqual(t.carrier, 'USPS');
});

check('builds a clickable link when Luma sends only a number', () => {
  const t = extractTracking(REAL_LUMA_SHIPPING_WEBHOOK, trackingUrlFor);
  assert.ok(t.trackingUrl.startsWith('https://tools.usps.com/'), `got "${t.trackingUrl}"`);
  assert.ok(t.trackingUrl.includes('9400000000000000000000'));
});

check('still accepts a flat payload, should Luma ever send one', () => {
  const t = extractTracking(
    { orderNumber: '1', trackingNumber: '1Z999', carrier: 'UPS' }, trackingUrlFor);
  assert.strictEqual(t.trackingNumber, '1Z999');
  assert.ok(t.trackingUrl.includes('ups.com'));
});

check('reports nothing rather than guessing when tracking is absent', () => {
  const t = extractTracking({ orderNumber: '1', shipments: [] }, trackingUrlFor);
  assert.strictEqual(t.trackingNumber, '');
  assert.strictEqual(t.trackingUrl, '', 'must not invent a link with no number');
});

check('an unknown carrier yields no link rather than a wrong one', () => {
  assert.strictEqual(trackingUrlFor('Royal Mail', '123'), '');
});

// Guard against the handler drifting away from the shape this file pins.
check('the live handler still parses shipments[]', () => {
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'routes', 'lumaWebhooks.js'), 'utf8');
  assert.ok(/event\.shipments/.test(src),
    'lumaWebhooks.js no longer reads event.shipments — tracking will silently go blank');
  assert.ok(/HOLDING shipped email/.test(src),
    'the missing-tracking hold was removed — a customer could be told "shipped" with no tracking');
});

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
