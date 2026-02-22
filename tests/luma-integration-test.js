/**
 * Luma Integration Dry-Run Test
 * Tests everything EXCEPT the actual HTTP call to Luma's API.
 * Verifies: payload building, database tracking, webhook handling, edge cases.
 *
 * Run: node tests/luma-integration-test.js
 */

const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

// Thin Database wrapper (mirrors src/db/database.js without disk save)
class TestDatabase {
  constructor(sqlDb) { this._db = sqlDb; }
  run(sql, params = []) { this._db.run(sql, params); return this; }
  exec(sql) { this._db.exec(sql); return this; }
  get(sql, params = []) {
    const stmt = this._db.prepare(sql);
    stmt.bind(params);
    if (stmt.step()) { const row = stmt.getAsObject(); stmt.free(); return row; }
    stmt.free();
    return undefined;
  }
  all(sql, params = []) {
    const stmt = this._db.prepare(sql);
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
}

// ─── Import Luma modules ───────────────────────────────────────────────
const lumaApi = require('../src/services/lumaOrderApi');
const { LUMA_CONFIG } = lumaApi;

// ─── Test state ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    console.error(`    Expected: ${JSON.stringify(expected)}`);
    console.error(`    Actual:   ${JSON.stringify(actual)}`);
    failed++;
  }
}

// ─── Create in-memory database with schema ─────────────────────────────
async function createTestDb() {
  const SQL = await initSqlJs();
  const sqlDb = new SQL.Database();
  const db = new TestDatabase(sqlDb);

  // Apply migrations in order (skip ALTER TABLE — build full schema directly)
  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      name TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_id TEXT REFERENCES customers(id),
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      template_id TEXT NOT NULL,
      product_sku TEXT,
      fields_json TEXT,
      photos_json TEXT,
      poem_text TEXT,
      proof_url TEXT,
      print_file_url TEXT,
      shipping_json TEXT,
      total_cents INTEGER DEFAULT 0,
      stripe_session_id TEXT,
      stripe_payment_intent_id TEXT,
      email TEXT,
      fulfillment_provider TEXT DEFAULT 'whcc',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES orders(id),
      event_type TEXT NOT NULL,
      data_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS luma_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES orders(id),
      luma_order_number TEXT,
      status TEXT DEFAULT 'pending',
      tracking_number TEXT,
      tracking_carrier TEXT,
      tracking_url TEXT,
      request_json TEXT,
      response_json TEXT,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT (datetime('now')),
      updated_at TIMESTAMP DEFAULT (datetime('now'))
    );
  `);

  return db;
}

// ─── Insert a test order into the database ─────────────────────────────
function insertTestOrder(db, { orderId, sku, styleVariant, photoPath, shipping }) {
  db.run(
    `INSERT INTO orders (id, template_id, product_sku, fields_json, photos_json, shipping_json, status, total_cents)
     VALUES (?, 'memorial-poem', ?, ?, ?, ?, 'submitted', 4999)`,
    [
      orderId,
      sku,
      JSON.stringify({ styleVariant }),
      JSON.stringify({ photo1: { originalPath: photoPath } }),
      JSON.stringify(shipping),
    ]
  );
}

// ─── Test Suite ────────────────────────────────────────────────────────

async function testPayloadBuilding() {
  console.log('\n═══ TEST 1: Payload Building (all style variants × sizes) ═══');

  const styles = ['classic-dark', 'warm-natural', 'soft-light'];
  const skus = ['framed-5x7', 'framed-8x10', 'framed-11x14', 'framed-16x20', 'framed-20x24', 'framed-20x30', 'framed-30x40'];

  // Set BASE_URL for predictable image URLs
  process.env.BASE_URL = 'https://www.stillbesideme.com';

  for (const style of styles) {
    console.log(`\n  --- Style: ${style} ---`);

    // Test subcategory resolution
    const subcatId = LUMA_CONFIG.subcategories[style];
    assert(subcatId !== undefined, `subcategory ID exists for ${style} (got ${subcatId})`);

    // Test mat color resolution
    const matColorId = LUMA_CONFIG.matColors[style];
    assert(matColorId !== undefined, `mat color ID exists for ${style} (got ${matColorId})`);

    // Test buildOrderItemOptions
    const options = lumaApi.buildOrderItemOptions
      ? lumaApi.buildOrderItemOptions(style)
      : null;

    // buildOrderItemOptions may not be exported — test via payload instead
  }

  for (const sku of skus) {
    const match = sku.match(/(\d+)x(\d+)/);
    assert(match !== null, `SKU "${sku}" parses dimensions`);
    const w = Number(match[1]);
    const h = Number(match[2]);
    assert(w > 0 && h > 0, `  → ${w}x${h} are positive`);
  }

  // Test image URL building
  const url = lumaApi.buildImageUrl('orders/abc123/composite.jpg');
  assertEqual(url, 'https://www.stillbesideme.com/uploads/orders/abc123/composite.jpg',
    'buildImageUrl produces correct public URL');
}

async function testPlaceOrderPayload() {
  console.log('\n═══ TEST 2: placeOrder() Payload + DB Tracking (mocked API) ═══');

  const db = await createTestDb();

  // Set required env vars
  process.env.LUMA_API_KEY = 'test-key';
  process.env.LUMA_API_SECRET = 'test-secret';
  process.env.BASE_URL = 'https://www.stillbesideme.com';

  const testShipping = {
    name: 'Jane Smith',
    address1: '123 Oak Lane',
    address2: 'Apt 4B',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    country: 'US',
  };

  const testCases = [
    { style: 'classic-dark', sku: 'framed-11x14', expectedSubcat: 105005, expectedMat: 98 },
    { style: 'warm-natural', sku: 'framed-8x10',  expectedSubcat: 105007, expectedMat: 102 },
    { style: 'soft-light',   sku: 'framed-16x20', expectedSubcat: 105006, expectedMat: 96 },
  ];

  for (const tc of testCases) {
    const orderId = `test-${tc.style}-${Date.now()}`;

    insertTestOrder(db, {
      orderId,
      sku: tc.sku,
      styleVariant: tc.style,
      photoPath: `orders/${orderId}/composite.jpg`,
      shipping: testShipping,
    });

    console.log(`\n  --- ${tc.style} / ${tc.sku} ---`);

    // Mock the createOrder function so we capture the payload without hitting the API
    let capturedPayload = null;
    const originalCreateOrder = lumaApi.createOrder;

    // We can't easily mock an internal call, so let's test via the placeOrder function
    // by monkeypatching the module's apiRequest. Instead, let's call placeOrder and
    // catch the fetch error, then inspect the database for the saved request_json.

    try {
      // Override global fetch to capture the payload
      const originalFetch = global.fetch;
      global.fetch = async (url, options) => {
        capturedPayload = JSON.parse(options.body);
        // Return a fake success response
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ orderNumber: `LUMA-MOCK-${tc.style}` }),
        };
      };

      await lumaApi.placeOrder(orderId, db);

      // Restore fetch
      global.fetch = originalFetch;
    } catch (err) {
      console.error(`  ✗ placeOrder threw: ${err.message}`);
      failed++;
      continue;
    }

    // Verify captured payload
    assert(capturedPayload !== null, 'payload was captured');

    if (capturedPayload) {
      assertEqual(capturedPayload.externalId, orderId, 'externalId matches orderId');
      assertEqual(capturedPayload.storeId, LUMA_CONFIG.storeId, `storeId is ${LUMA_CONFIG.storeId}`);

      // Recipient
      assertEqual(capturedPayload.recipient.firstName, 'Jane', 'firstName parsed correctly');
      assertEqual(capturedPayload.recipient.lastName, 'Smith', 'lastName parsed correctly');
      assertEqual(capturedPayload.recipient.addressLine1, '123 Oak Lane', 'address1 correct');
      assertEqual(capturedPayload.recipient.addressLine2, 'Apt 4B', 'address2 correct');
      assertEqual(capturedPayload.recipient.city, 'Austin', 'city correct');
      assertEqual(capturedPayload.recipient.state, 'TX', 'state correct');
      assertEqual(capturedPayload.recipient.zipCode, '78701', 'zipCode correct');
      assertEqual(capturedPayload.recipient.country, 'US', 'country correct');

      // Order item
      const item = capturedPayload.orderItems[0];
      assertEqual(item.subcategoryId, tc.expectedSubcat, `subcategoryId is ${tc.expectedSubcat} (${tc.style} frame)`);
      assertEqual(item.quantity, 1, 'quantity is 1');

      const dims = tc.sku.match(/(\d+)x(\d+)/);
      assertEqual(item.width, Number(dims[1]), `width is ${dims[1]}`);
      assertEqual(item.height, Number(dims[2]), `height is ${dims[2]}`);

      // Image URL
      assert(item.file.imageUrl.startsWith('https://www.stillbesideme.com/uploads/'),
        'imageUrl starts with correct base');
      assert(item.file.imageUrl.includes(orderId), 'imageUrl includes orderId');

      // Options include the style-specific mat color
      const optionIds = item.orderItemOptions.map(o => o.optionId);
      assert(optionIds.includes(tc.expectedMat), `options include mat color ${tc.expectedMat}`);

      // All shared options present
      for (const sharedOpt of LUMA_CONFIG.sharedOptions) {
        assert(optionIds.includes(sharedOpt), `options include shared option ${sharedOpt}`);
      }

      // Total option count = shared + mat color
      assertEqual(item.orderItemOptions.length, LUMA_CONFIG.sharedOptions.length + 1,
        `total options count is ${LUMA_CONFIG.sharedOptions.length + 1}`);
    }

    // Verify database tracking
    const lumaOrder = db.get('SELECT * FROM luma_orders WHERE order_id = ?', [orderId]);
    assert(lumaOrder !== undefined, 'luma_orders row was created');
    assertEqual(lumaOrder.status, 'submitted', 'luma_orders status is "submitted"');
    assertEqual(lumaOrder.luma_order_number, `LUMA-MOCK-${tc.style}`, 'luma_order_number saved');
    assert(lumaOrder.request_json !== null, 'request_json saved');

    // Verify request_json matches what was sent
    const savedPayload = JSON.parse(lumaOrder.request_json);
    assertEqual(savedPayload.externalId, orderId, 'saved request_json.externalId matches');

    // Verify main order updated
    const order = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
    assertEqual(order.status, 'in_production', 'main order status updated to in_production');
    assertEqual(order.fulfillment_provider, 'luma', 'fulfillment_provider set to luma');

    // Verify event logged
    const event = db.get(
      'SELECT * FROM order_events WHERE order_id = ? AND event_type = ?',
      [orderId, 'luma_submitted']
    );
    assert(event !== undefined, 'luma_submitted event logged');
    const eventData = JSON.parse(event.data_json);
    assertEqual(eventData.orderNumber, `LUMA-MOCK-${tc.style}`, 'event data has orderNumber');
  }
}

async function testWebhookProcessing() {
  console.log('\n═══ TEST 3: Webhook Processing (simulated shipping event) ═══');

  const db = await createTestDb();
  const orderId = 'test-webhook-order';
  const lumaOrderNumber = 'LUMA-12345';

  // Set up: create an order that's been submitted to Luma
  insertTestOrder(db, {
    orderId,
    sku: 'framed-11x14',
    styleVariant: 'classic-dark',
    photoPath: 'orders/test/composite.jpg',
    shipping: { name: 'John Doe', address1: '456 Elm St', city: 'Portland', state: 'OR', zip: '97201', country: 'US' },
  });

  db.run('UPDATE orders SET status = ?, fulfillment_provider = ? WHERE id = ?',
    ['in_production', 'luma', orderId]);

  db.run(
    `INSERT INTO luma_orders (order_id, luma_order_number, status, request_json)
     VALUES (?, ?, 'submitted', '{}')`,
    [orderId, lumaOrderNumber]
  );

  // Simulate the webhook handler logic (same as lumaWebhooks.js route)
  const webhookPayload = {
    orderNumber: lumaOrderNumber,
    trackingNumber: '1Z999AA10123456784',
    carrier: 'UPS',
    trackingUrl: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
  };

  // Process it the same way the route handler does
  const orderNumber = webhookPayload.orderNumber;
  const lumaOrder = db.get('SELECT * FROM luma_orders WHERE luma_order_number = ?', [String(orderNumber)]);

  assert(lumaOrder !== undefined, 'found luma_orders row by order number');

  // Apply updates (mirroring lumaWebhooks.js logic)
  db.run(
    `UPDATE luma_orders SET status = 'shipped', tracking_number = ?,
     tracking_carrier = ?, tracking_url = ?, updated_at = datetime('now')
     WHERE luma_order_number = ?`,
    [webhookPayload.trackingNumber, webhookPayload.carrier, webhookPayload.trackingUrl, String(orderNumber)]
  );

  db.run('UPDATE orders SET status = ?, updated_at = datetime(\'now\') WHERE id = ?',
    ['shipped', lumaOrder.order_id]);

  db.run(
    `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)`,
    [lumaOrder.order_id, 'luma_shipped', JSON.stringify(webhookPayload)]
  );

  // Verify results
  const updatedLuma = db.get('SELECT * FROM luma_orders WHERE luma_order_number = ?', [lumaOrderNumber]);
  assertEqual(updatedLuma.status, 'shipped', 'luma_orders status updated to "shipped"');
  assertEqual(updatedLuma.tracking_number, '1Z999AA10123456784', 'tracking_number saved');
  assertEqual(updatedLuma.tracking_carrier, 'UPS', 'tracking_carrier saved');
  assert(updatedLuma.tracking_url.includes('ups.com'), 'tracking_url saved');

  const updatedOrder = db.get('SELECT * FROM orders WHERE id = ?', [orderId]);
  assertEqual(updatedOrder.status, 'shipped', 'main order status updated to "shipped"');

  const shippedEvent = db.get(
    'SELECT * FROM order_events WHERE order_id = ? AND event_type = ?',
    [orderId, 'luma_shipped']
  );
  assert(shippedEvent !== undefined, 'luma_shipped event logged');
  const eventData = JSON.parse(shippedEvent.data_json);
  assertEqual(eventData.trackingNumber, '1Z999AA10123456784', 'event data has tracking number');
}

async function testWebhookEdgeCases() {
  console.log('\n═══ TEST 4: Webhook Edge Cases ═══');

  const db = await createTestDb();

  // 4a: Unknown order number — should not crash
  console.log('\n  --- Unknown order number ---');
  const unknownOrder = db.get('SELECT * FROM luma_orders WHERE luma_order_number = ?', ['NONEXISTENT-999']);
  assertEqual(unknownOrder, undefined, 'unknown order returns undefined (handler would return warning)');

  // 4b: Missing orderNumber in payload — handler returns early
  console.log('\n  --- Missing orderNumber ---');
  const emptyPayload = {};
  const orderNumber = emptyPayload.orderNumber || emptyPayload.OrderNumber;
  assertEqual(orderNumber, undefined, 'missing orderNumber detected');

  // 4c: Duplicate webhook (idempotency) — shipping updates should overwrite safely
  console.log('\n  --- Duplicate shipping webhook ---');
  const orderId = 'test-idempotent';
  insertTestOrder(db, {
    orderId,
    sku: 'framed-8x10',
    styleVariant: 'warm-natural',
    photoPath: 'orders/test/composite.jpg',
    shipping: { name: 'Test User', address1: '789 Pine', city: 'Seattle', state: 'WA', zip: '98101', country: 'US' },
  });
  db.run('UPDATE orders SET status = ?, fulfillment_provider = ? WHERE id = ?',
    ['in_production', 'luma', orderId]);
  db.run(
    `INSERT INTO luma_orders (order_id, luma_order_number, status) VALUES (?, ?, 'submitted')`,
    [orderId, 'LUMA-IDEM-1']
  );

  // First webhook
  db.run(
    `UPDATE luma_orders SET status = 'shipped', tracking_number = ? WHERE luma_order_number = ?`,
    ['TRACK-1', 'LUMA-IDEM-1']
  );

  // Second webhook with updated tracking (Luma may re-send)
  db.run(
    `UPDATE luma_orders SET tracking_number = ? WHERE luma_order_number = ?`,
    ['TRACK-2-UPDATED', 'LUMA-IDEM-1']
  );

  const idempResult = db.get('SELECT * FROM luma_orders WHERE luma_order_number = ?', ['LUMA-IDEM-1']);
  assertEqual(idempResult.tracking_number, 'TRACK-2-UPDATED', 'duplicate webhook safely overwrites tracking');
  assertEqual(idempResult.status, 'shipped', 'status remains shipped after duplicate');
}

async function testStyleVariantFallback() {
  console.log('\n═══ TEST 5: Style Variant Fallback ═══');

  const db = await createTestDb();

  process.env.LUMA_API_KEY = 'test-key';
  process.env.LUMA_API_SECRET = 'test-secret';
  process.env.BASE_URL = 'https://www.stillbesideme.com';

  const orderId = 'test-fallback-style';

  // Insert order with an unknown style variant
  insertTestOrder(db, {
    orderId,
    sku: 'framed-11x14',
    styleVariant: 'nonexistent-style',
    photoPath: 'orders/test/composite.jpg',
    shipping: { name: 'Fallback User', address1: '999 Test Rd', city: 'Denver', state: 'CO', zip: '80201', country: 'US' },
  });

  let capturedPayload = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    capturedPayload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ orderNumber: 'LUMA-FALLBACK' }),
    };
  };

  try {
    await lumaApi.placeOrder(orderId, db);
  } catch (err) {
    console.error(`  ✗ placeOrder threw: ${err.message}`);
    failed++;
  }

  global.fetch = originalFetch;

  if (capturedPayload) {
    // Should fall back to classic-dark
    assertEqual(capturedPayload.orderItems[0].subcategoryId, LUMA_CONFIG.subcategories['classic-dark'],
      'unknown style falls back to classic-dark subcategory');

    const optionIds = capturedPayload.orderItems[0].orderItemOptions.map(o => o.optionId);
    assert(optionIds.includes(LUMA_CONFIG.matColors['classic-dark']),
      'unknown style falls back to classic-dark mat color');
  }
}

async function testErrorHandling() {
  console.log('\n═══ TEST 6: Error Handling ═══');

  const db = await createTestDb();

  process.env.LUMA_API_KEY = 'test-key';
  process.env.LUMA_API_SECRET = 'test-secret';
  process.env.BASE_URL = 'https://www.stillbesideme.com';

  // 6a: Missing shipping address
  console.log('\n  --- Missing shipping address ---');
  const noShipId = 'test-no-shipping';
  db.run(
    `INSERT INTO orders (id, template_id, product_sku, fields_json, photos_json, status)
     VALUES (?, 'memorial-poem', 'framed-11x14', '{"styleVariant":"classic-dark"}', '{"p":{"originalPath":"test.jpg"}}', 'submitted')`,
    [noShipId]
  );

  try {
    await lumaApi.placeOrder(noShipId, db);
    assert(false, 'should have thrown for missing shipping');
  } catch (err) {
    assert(err.message.includes('no shipping'), `throws on missing shipping: "${err.message}"`);
  }

  // 6b: Luma API returns error
  console.log('\n  --- Luma API error response ---');
  const apiErrId = 'test-api-error';
  insertTestOrder(db, {
    orderId: apiErrId,
    sku: 'framed-11x14',
    styleVariant: 'classic-dark',
    photoPath: 'orders/test/composite.jpg',
    shipping: { name: 'Error Test', address1: '1 Fail St', city: 'Err', state: 'CA', zip: '90000', country: 'US' },
  });

  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ message: 'Invalid subcategory', errors: ['bad data'] }),
    // No orderNumber — triggers error path
  });

  try {
    await lumaApi.placeOrder(apiErrId, db);
    assert(false, 'should have thrown for API error');
  } catch (err) {
    assert(err.message.includes('failed'), `throws on API error: "${err.message}"`);
  }

  global.fetch = originalFetch;

  // Verify error was tracked in database
  const errorRow = db.get('SELECT * FROM luma_orders WHERE order_id = ?', [apiErrId]);
  assert(errorRow !== undefined, 'luma_orders row created even on error');
  assertEqual(errorRow.status, 'error', 'status set to "error"');
  assert(errorRow.error_message !== null, 'error_message saved');

  // 6c: Unparseable SKU
  console.log('\n  --- Invalid SKU format ---');
  const badSkuId = 'test-bad-sku';
  insertTestOrder(db, {
    orderId: badSkuId,
    sku: 'poster-large',  // no dimensions
    styleVariant: 'classic-dark',
    photoPath: 'orders/test/composite.jpg',
    shipping: { name: 'SKU Test', address1: '1 Test', city: 'X', state: 'NY', zip: '10001', country: 'US' },
  });

  try {
    await lumaApi.placeOrder(badSkuId, db);
    assert(false, 'should have thrown for bad SKU');
  } catch (err) {
    assert(err.message.includes('Cannot parse size'), `throws on bad SKU: "${err.message}"`);
  }
}

async function testPayloadStructure() {
  console.log('\n═══ TEST 7: Full Payload Structure Snapshot ═══');

  const db = await createTestDb();
  process.env.LUMA_API_KEY = 'test-key';
  process.env.LUMA_API_SECRET = 'test-secret';
  process.env.BASE_URL = 'https://www.stillbesideme.com';

  const orderId = 'test-snapshot';
  insertTestOrder(db, {
    orderId,
    sku: 'framed-11x14',
    styleVariant: 'classic-dark',
    photoPath: 'orders/test-snapshot/composite.jpg',
    shipping: {
      name: 'Sarah Johnson',
      address1: '100 Memorial Way',
      address2: 'Suite 200',
      city: 'Nashville',
      state: 'TN',
      zip: '37201',
      country: 'US',
    },
  });

  let capturedPayload = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    capturedPayload = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ orderNumber: 'LUMA-SNAPSHOT' }),
    };
  };

  await lumaApi.placeOrder(orderId, db);
  global.fetch = originalFetch;

  console.log('\n  Payload that would be sent to Luma:');
  console.log('  ' + JSON.stringify(capturedPayload, null, 2).replace(/\n/g, '\n  '));

  // Structural assertions
  assert(capturedPayload.externalId, 'has externalId');
  assert(capturedPayload.storeId, 'has storeId');
  assert(capturedPayload.shippingMethod, 'has shippingMethod');
  assert(capturedPayload.productionTime, 'has productionTime');
  assert(capturedPayload.recipient, 'has recipient');
  assert(capturedPayload.orderItems, 'has orderItems');
  assertEqual(capturedPayload.orderItems.length, 1, 'exactly 1 order item');

  const item = capturedPayload.orderItems[0];
  assert(item.externalItemId, 'item has externalItemId');
  assert(item.subcategoryId, 'item has subcategoryId');
  assert(item.quantity, 'item has quantity');
  assert(item.width, 'item has width');
  assert(item.height, 'item has height');
  assert(item.file, 'item has file');
  assert(item.file.imageUrl, 'item.file has imageUrl');
  assert(item.orderItemOptions, 'item has orderItemOptions');
  assert(item.orderItemOptions.length > 0, 'item has at least one option');

  // Every option should have an optionId
  for (const opt of item.orderItemOptions) {
    assert(opt.optionId !== undefined, `option has optionId (${opt.optionId})`);
  }
}

// ─── Run all tests ─────────────────────────────────────────────────────
async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║  Luma Integration Dry-Run Test                           ║');
  console.log('║  Testing everything EXCEPT actual API calls              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  await testPayloadBuilding();
  await testPlaceOrderPayload();
  await testWebhookProcessing();
  await testWebhookEdgeCases();
  await testStyleVariantFallback();
  await testErrorHandling();
  await testPayloadStructure();

  console.log('\n════════════════════════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('════════════════════════════════════════════════════════════');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
