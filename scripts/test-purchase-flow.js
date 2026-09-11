/**
 * Smoke test: the checkout gate.
 *
 * This used to POST /api/checkout and assert only that the response did not
 * contain the string "No photos" — so once checkout started (correctly)
 * refusing every request without an approved proof, the script got a blanket
 * `400 approval_required`, found no "No photos" in it, printed "passed" and
 * exited 0. It could not fail. A test that cannot fail is worse than no test:
 * it is a green light wired to nothing.
 *
 * So it now asserts the contract instead of the absence of one string:
 *   1. POST /api/images/upload accepts a real photo (the sharp/HEIC pipeline).
 *   2. POST /api/checkout with no orderId/approved is REFUSED 400
 *      approval_required — no order can reach Stripe without a proof approval.
 *   3. POST /api/checkout/proof from a session that never uploaded anything is
 *      refused 400 with the no-photos error.
 *   4. If the server handed back a session cookie, a proof request carrying it
 *      must NOT hit the no-photos error — the original regression this script
 *      was written for (photos vanishing between requests).
 *
 * It never tries to drive a live Stripe purchase; everything past the approval
 * gate needs real card entry.
 *
 * Usage: node scripts/test-purchase-flow.js      (server running on 3001)
 *        TEST_BASE_URL=http://localhost:3199 node scripts/test-purchase-flow.js
 */
const fs = require('fs');
const path = require('path');

const BASE = (process.env.TEST_BASE_URL || process.env.BASE_URL
  || `http://localhost:${process.env.PORT || 3001}`).replace(/\/+$/, '');

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** The customizer payload, minus the approval fields /api/checkout requires. */
function draftPayload() {
  return {
    templateId: 'pet-tribute', sku: 'framed-11x14',
    fields: { petName: 'Scout' },
    poemText: 'A short test poem for Scout.',
    colors: { frame: '#8a5a3c', accent: '#F4ECDD', tone: 'dark', mat: '#1c1611', bevel: '#C4A882', text: '#FAF8F5' },
    frameIcon: 'paw', style: 'classic-dark', layout: 'side-by-side', orderType: 'self',
  };
}

async function postJson(urlPath, body, cookie) {
  const res = await fetch(BASE + urlPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

(async () => {
  console.log(`Purchase-flow smoke test against ${BASE}\n`);

  // 1. Upload a real photo. Worth asserting on its own: this is the whole
  //    sharp/HEIC/thumbnail/crop pipeline, and it is the first thing a customer
  //    touches.
  const buf = fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'stock', 'golden-retriever.jpg'));
  const fd = new FormData();
  fd.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'golden.jpg');
  fd.append('slotId', 'main');

  const up = await fetch(BASE + '/api/images/upload', {
    method: 'POST', body: fd, signal: AbortSignal.timeout(60000),
  });
  const upJson = await up.json().catch(() => ({}));
  const setCookie = up.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0] : '';
  check('upload accepts a JPEG', up.status === 200 && upJson.success === true,
    `status=${up.status} success=${upJson.success} palette=${!!upJson.palette}`);

  // 2. The approval gate. Nothing may reach Stripe without an approved proof,
  //    so a payload with no orderId/approved must be refused — and refused with
  //    the documented code, because the customizer branches on it to re-render
  //    the proof rather than showing a dead end.
  const noApproval = await postJson('/api/checkout', draftPayload(), cookie);
  check('checkout refuses an unapproved order',
    noApproval.status === 400 && noApproval.json.code === 'approval_required',
    `status=${noApproval.status} code=${noApproval.json.code} error=${JSON.stringify(noApproval.json.error || '').slice(0, 80)}`);

  // 3. No photo, no proof. A cookie-less request is a brand-new session, which
  //    by definition has no uploaded photos, so the draft builder must stop it.
  const noPhotos = await postJson('/api/checkout/proof', draftPayload(), '');
  check('proof refuses a session with no photos',
    noPhotos.status === 400 && /no photos/i.test(String(noPhotos.json.error || '')),
    `status=${noPhotos.status} error=${JSON.stringify(noPhotos.json.error || '').slice(0, 80)}`);

  // 4. The original regression: photos uploaded in one request must still be
  //    there in the next. Only checkable when we actually hold a session cookie
  //    — a server running NODE_ENV=production over plain HTTP withholds the
  //    `secure` cookie, which is correct behaviour, not a failure.
  if (cookie) {
    const withPhoto = await postJson('/api/checkout/proof', draftPayload(), cookie);
    const lostPhotos = /no photos/i.test(JSON.stringify(withPhoto.json));
    check('uploaded photo survives into the next request', !lostPhotos,
      `status=${withPhoto.status} ${JSON.stringify(withPhoto.json).slice(0, 100)}`);
  } else {
    console.log('  SKIP  uploaded photo survives into the next request — no session cookie returned'
      + ' (expected when NODE_ENV=production is reached over plain HTTP)');
  }

  console.log(`\n${failures ? `${failures} assertion(s) FAILED` : 'All assertions passed'}`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('Smoke test could not run:', e.message); process.exit(2); });
