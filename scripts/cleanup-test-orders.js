/**
 * Remove seeded/test orders (test@example.com or test-* ids) from the local DB.
 * Usage: node scripts/cleanup-test-orders.js  (server must not be running)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  const db = await require('../src/db/database').init();
  const rows = db.all(
    "SELECT id FROM orders WHERE email = 'test@example.com' OR id LIKE 'test-%'"
  );
  for (const r of rows) {
    db.run('DELETE FROM order_events WHERE order_id = ?', [r.id]);
    db.run('DELETE FROM orders WHERE id = ?', [r.id]);
  }
  console.log(`Removed ${rows.length} test order(s)`);
  await new Promise((r) => setTimeout(r, 500)); // wait for debounced save
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
