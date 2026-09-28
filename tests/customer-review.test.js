/**
 * The customer review system, end to end, against a real (temporary) database.
 *
 * Three things have to be true before REVIEW_INVITES_ENABLED is ever flipped
 * on in production, and this proves each of them:
 *
 *   1. The invite engine asks each family exactly once, ten days after the
 *      piece shipped, only inside the 60-day window, only if we hold an email,
 *      and never logs a send that did not really happen (no-SMTP preview).
 *   2. The review page's submit works over the multipart contract the page now
 *      uses (photo included) AND the older JSON contract, refuses a second
 *      review per order, and never lets a customer publish anything.
 *   3. The photo is normalised (upright, resized, metadata gone) and reachable
 *      from outside only while the review is published with consent.
 *
 *   node tests/customer-review.test.js
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Environment BEFORE any module under test loads: they read it at require time.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sbm-review-test-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.UPLOADS_DIR = path.join(TMP, 'uploads');
process.env.BASE_URL = 'https://example.test';
delete process.env.SMTP_HOST;
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const express = require('express');
const sharp = require('sharp');
const database = require('../src/db/database');
const emailService = require('../src/services/emailService');
const reviewInviteEngine = require('../src/services/reviewInviteEngine');
const customerReviewRouter = require('../src/routes/customerReview');

const ORDER_COLS = `(id, template_id, status, email, proof_token, fields_json)`;
function insertOrder(db, id, { email, daysSinceShipped, status = 'shipped', pet = 'Rex' }) {
  db.run(
    `INSERT INTO orders ${ORDER_COLS} VALUES (?, 'pet', ?, ?, ?, ?)`,
    [id, status, email, `tok-${id}-0123456789`, JSON.stringify({ petName: pet })]
  );
  if (daysSinceShipped != null) {
    db.run(
      `INSERT INTO order_events (order_id, event_type, created_at)
       VALUES (?, 'luma_shipped', datetime('now', ?))`,
      [id, `-${daysSinceShipped} days`]
    );
  }
}

/** A phone-shaped photo: landscape pixels, EXIF says "rotate me", plus copyright to prove stripping. */
async function phonePhoto() {
  return sharp({ create: { width: 2400, height: 1200, channels: 3, background: '#8B9D83' } })
    .jpeg()
    .withMetadata({ orientation: 6, exif: { IFD0: { Copyright: 'Living room, with GPS' } } })
    .toBuffer();
}

async function postMultipart(base, token, fields, photo) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  if (photo) form.append('photo', new Blob([photo.buffer], { type: photo.type }), photo.name);
  const r = await fetch(`${base}/api/review/${token}`, { method: 'POST', body: form });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

(async () => {
  const db = await database.init();

  // ── 1. The invite engine ─────────────────────────────────────────────
  insertOrder(db, 'ready', { email: 'family@example.test', daysSinceShipped: 12 });
  insertOrder(db, 'tooSoon', { email: 'soon@example.test', daysSinceShipped: 2 });
  insertOrder(db, 'ancient', { email: 'old@example.test', daysSinceShipped: 90 });
  insertOrder(db, 'etsy', { email: null, daysSinceShipped: 12 });
  insertOrder(db, 'notShipped', { email: 'wait@example.test', daysSinceShipped: null, status: 'submitted' });

  const calls = [];
  const realSend = emailService.sendReviewInvite;
  let mode = 'preview';
  emailService.sendReviewInvite = async (to, data, url) => {
    calls.push({ to, data, url });
    return mode === 'preview' ? { preview: true } : { messageId: `msg-${calls.length}` };
  };

  let run = await reviewInviteEngine.checkAndSend();
  assert.deepStrictEqual(run, { sent: 0, skipped: 0, failed: 1 }, 'preview send is not a send');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].to, 'family@example.test');
  assert.strictEqual(calls[0].data.petName, 'Rex');
  assert.strictEqual(calls[0].url, 'https://example.test/review/tok-ready-0123456789');
  assert.strictEqual(
    db.get(`SELECT COUNT(*) AS n FROM order_events WHERE event_type = 'review_invite_sent'`).n, 0,
    'a preview must not burn the single ask'
  );

  mode = 'real';
  run = await reviewInviteEngine.checkAndSend();
  assert.deepStrictEqual(run, { sent: 1, skipped: 0, failed: 0 }, 'one real send for the one eligible order');
  assert.strictEqual(calls.length, 2);

  run = await reviewInviteEngine.checkAndSend();
  assert.deepStrictEqual(run, { sent: 0, skipped: 1, failed: 0 }, 'never asked twice');
  assert.strictEqual(calls.length, 2, 'no email on the second run');
  emailService.sendReviewInvite = realSend;

  // The real email says the words that matter.
  const captured = [];
  const origLog = console.log;
  console.log = (...a) => captured.push(a.join(' '));
  await realSend('x@example.test', { orderId: 'ready', petName: 'Rex' }, 'https://example.test/review/t');
  console.log = origLog;
  const emailText = captured.join('\n');
  assert.ok(/Did Rex's piece arrive safely\?/.test(emailText), 'subject names the pet');

  // ── 2 & 3. Submit, photo, gate ───────────────────────────────────────
  const app = express();
  app.locals.db = db;
  app.use('/api', customerReviewRouter);
  const server = await new Promise(resolve => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const TOKEN = 'tok-ready-0123456789';

  let r = await fetch(`${base}/api/review/${TOKEN}`).then(x => x.json());
  assert.deepStrictEqual(r, { petName: 'Rex', alreadySubmitted: false, submittedRating: null });

  // Rating is required, whatever else is sent.
  let out = await postMultipart(base, TOKEN, { body: 'no stars' });
  assert.strictEqual(out.status, 400);

  // A file that is not an image costs a retry, not a half-saved review.
  out = await postMultipart(base, TOKEN, { rating: 5 }, { buffer: Buffer.from('not a picture'), type: 'image/jpeg', name: 'x.jpg' });
  assert.strictEqual(out.status, 400);
  assert.strictEqual(db.get('SELECT COUNT(*) AS n FROM customer_reviews').n, 0, 'nothing saved for a bad photo');

  // The real thing: five stars, words, a phone photo, consent given.
  const photo = await phonePhoto();
  out = await postMultipart(base, TOKEN,
    { rating: 5, body: 'It looks exactly like him.', authorDisplay: 'Keith L.', consentToPublish: 'true' },
    { buffer: photo, type: 'image/jpeg', name: 'IMG_0001.jpg' });
  assert.strictEqual(out.status, 200, JSON.stringify(out.body));
  assert.strictEqual(out.body.hasPhoto, true);

  const row = db.get(`SELECT * FROM customer_reviews WHERE order_id = 'ready'`);
  assert.strictEqual(row.status, 'pending', 'a customer can never publish');
  assert.strictEqual(row.consent_to_publish, 1);
  assert.strictEqual(row.photo_path, 'reviews/ready.jpg');
  const stored = path.join(process.env.UPLOADS_DIR, 'reviews', 'ready.jpg');
  assert.ok(fs.existsSync(stored), 'photo landed on the uploads volume');

  const meta = await sharp(stored).metadata();
  assert.strictEqual(meta.format, 'jpeg');
  assert.strictEqual(meta.exif, undefined, 'metadata stripped');
  assert.strictEqual(meta.orientation, undefined, 'orientation baked in, tag gone');
  assert.deepStrictEqual([meta.width, meta.height], [800, 1600], 'rotated upright and bounded to 1600px');

  // One review per order, kindly.
  out = await postMultipart(base, TOKEN, { rating: 4 });
  assert.strictEqual(out.status, 409);
  assert.strictEqual(out.body.alreadySubmitted, true);
  r = await fetch(`${base}/api/review/${TOKEN}`).then(x => x.json());
  assert.strictEqual(r.alreadySubmitted, true);

  // Pending means invisible: no review, no photo.
  let pub = await fetch(`${base}/api/reviews`).then(x => x.json());
  assert.strictEqual(pub.newCount, 0);
  assert.deepStrictEqual(pub.reviews, []);
  let img = await fetch(`${base}/api/reviews/${row.id}/photo`);
  assert.strictEqual(img.status, 404, 'unpublished photo is unreachable');

  // The owner publishes (what the admin route does), and the site follows.
  db.run(`UPDATE customer_reviews SET status = 'published', published_at = datetime('now') WHERE id = ?`, [row.id]);
  pub = await fetch(`${base}/api/reviews`).then(x => x.json());
  assert.strictEqual(pub.newCount, 1);
  assert.strictEqual(pub.reviews[0].author, 'Keith L.');
  assert.strictEqual(pub.reviews[0].photoUrl, `/api/reviews/${row.id}/photo`);
  assert.ok(pub.aggregateRating && pub.aggregateRating.reviewCount, 'aggregate present');
  img = await fetch(`${base}/api/reviews/${row.id}/photo`);
  assert.strictEqual(img.status, 200);
  assert.strictEqual(img.headers.get('content-type'), 'image/jpeg');
  assert.ok((await img.arrayBuffer()).byteLength > 1000);

  // Hiding is the takedown.
  db.run(`UPDATE customer_reviews SET status = 'hidden', published_at = NULL WHERE id = ?`, [row.id]);
  img = await fetch(`${base}/api/reviews/${row.id}/photo`);
  assert.strictEqual(img.status, 404, 'hidden photo is gone from outside');

  // No consent: even a published status serves nothing. The older JSON shape
  // is used here to prove that contract still works.
  const TOKEN2 = 'tok-tooSoon-0123456789';
  const jr = await fetch(`${base}/api/review/${TOKEN2}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rating: 5, body: 'private words', consentToPublish: false }),
  });
  assert.strictEqual(jr.status, 200);
  const row2 = db.get(`SELECT * FROM customer_reviews WHERE order_id = 'tooSoon'`);
  assert.strictEqual(row2.consent_to_publish, 0);
  assert.strictEqual(row2.photo_path, null);
  db.run(`UPDATE customer_reviews SET status = 'published', published_at = datetime('now') WHERE id = ?`, [row2.id]);
  pub = await fetch(`${base}/api/reviews`).then(x => x.json());
  assert.strictEqual(pub.newCount, 0, 'published without consent is still never shown');

  // Someone who already reviewed is never invited, even if eligible.
  db.run(`DELETE FROM order_events WHERE event_type = 'review_invite_sent'`);
  emailService.sendReviewInvite = async () => { throw new Error('should not be called'); };
  run = await reviewInviteEngine.checkAndSend();
  emailService.sendReviewInvite = realSend;
  assert.deepStrictEqual(run, { sent: 0, skipped: 1, failed: 0 }, 'reviewed order is skipped without an email');

  server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('customer-review: all assertions passed');
  process.exit(0);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
