/**
 * Smoke test: upload a photo, then checkout with the same session cookie.
 * Confirms photos persist across requests (the "no photos uploaded" bug).
 * Usage: node scripts/test-purchase-flow.js   (server must be running on 3001)
 */
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:3001';

(async () => {
  // 1. Upload a photo
  const buf = fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'stock', 'golden-retriever.jpg'));
  const fd = new FormData();
  fd.append('photo', new Blob([buf], { type: 'image/jpeg' }), 'golden.jpg');
  fd.append('slotId', 'main');

  const up = await fetch(BASE + '/api/images/upload', { method: 'POST', body: fd });
  const setCookie = up.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0] : '';
  const upJson = await up.json();
  console.log('UPLOAD:', up.status, 'success=' + upJson.success, 'gotCookie=' + !!cookie, 'palette=' + !!upJson.palette);

  // 2. Checkout reusing that session cookie
  const co = await fetch(BASE + '/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Cookie': cookie },
    body: JSON.stringify({
      templateId: 'pet-tribute', sku: 'framed-11x14',
      fields: { petName: 'Scout' },
      poemText: 'A short test poem for Scout.',
      colors: { frame: '#8a5a3c', accent: '#F4ECDD', tone: 'dark', mat: '#1c1611', bevel: '#C4A882', text: '#FAF8F5' },
      frameIcon: 'paw', style: 'classic-dark', layout: 'side-by-side', orderType: 'self'
    })
  });
  const coJson = await co.json();
  const noPhotos = JSON.stringify(coJson).includes('No photos');
  console.log('CHECKOUT:', co.status, noPhotos ? 'FAILED — still says "No photos"' : 'passed photo check', '→', JSON.stringify(coJson).slice(0, 120));
  process.exit(noPhotos ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(2); });
