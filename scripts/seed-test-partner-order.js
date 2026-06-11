/**
 * Seed a test partner-fulfilled order for verifying the admin fulfillment flow.
 * Usage: node scripts/seed-test-partner-order.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

(async () => {
  const db = await require('../src/db/database').init();
  const { v4: uuid } = require('uuid');
  const id = uuid();

  db.run(
    `INSERT INTO orders (
       id, session_id, status, template_id, product_sku,
       fields_json, photos_json, poem_text, total_cents, email,
       shipping_json, proof_token, admin_token, fulfillment_provider,
       print_file_url, proof_url
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      id, 'test-session', 'in_production', 'pet-tribute', 'framed-11x14',
      JSON.stringify({
        petName: 'Scout',
        layout: 'side-by-side',
        colors: { mat: '#1c2016', bevel: '#89b946', text: '#f1f3e7', tone: 'dark' },
      }),
      JSON.stringify({ main: { originalPath: '_colortest.png', crop: { position: '50% 50%' } } }),
      'Test poem for Scout', 15995, 'test@example.com',
      JSON.stringify({ name: 'Test Customer', address1: '123 Main St', city: 'Austin', state: 'TX', zip: '78701', country: 'US' }),
      'prooftoken-' + id.slice(0, 8),
      'admintoken-' + id.slice(0, 8),
      'partner',
      '/output/print-ready/test-printedmat.jpg',
      '/output/proofs/test-printedmat.jpg',
    ]
  );

  db.run('INSERT INTO order_events (order_id, event_type, data_json) VALUES (?,?,?)', [id, 'order_created', '{}']);

  // db.run save is debounced (100ms) — wait for the flush before exiting
  await new Promise((r) => setTimeout(r, 500));

  console.log('SEEDED');
  console.log('admin_token = admintoken-' + id.slice(0, 8));
  console.log('proof_token = prooftoken-' + id.slice(0, 8));
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
