/**
 * Build gallery images of REAL customer tributes from their print-ready files.
 *
 * The demo pieces in the homepage gallery are rendered from invented pets in
 * generate-frame-mockups.js. This script does the same job for pieces we
 * actually made and shipped: it takes the unwatermarked print file for an order
 * and wraps it in the same frame-on-wall geometry, so a real piece and a demo
 * piece sit in one grid without looking like two different photo shoots.
 *
 * Framing is imported, never reimplemented. If the molding changes in
 * generate-frame-mockups.js it changes here on the next run.
 *
 * Usage:
 *   node scripts/build-real-tribute-images.js --orders=<id>:<slug>,<id>:<slug>
 *     [--src=<dir>]     read <id>.jpg from here instead of fetching over HTTPS
 *     [--out=<dir>]     write <slug>.jpg here (default: output/real-tributes)
 *     [--base=<url>]    site to fetch print files from
 *
 * Source files are customer property. They are fetched to a working directory
 * and are NOT written into the repo by this script. Where the finished gallery
 * images are allowed to live is a separate decision: see tasks/todo.md.
 */

const path = require('path');
const fs = require('fs');
const https = require('https');

const ROOT = path.join(__dirname, '..');
const { frameOnWall, WALLS } = require('./generate-frame-mockups');

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const SRC_DIR = arg('src', null);
const OUT_DIR = arg('out', path.join(ROOT, 'output', 'real-tributes'));
const BASE = arg('base', 'https://www.stillbesideme.com');

/** Print-ready dimensions tell us the size; the sku is not needed here. */
const SIZE_BY_LONG_EDGE = { 4200: [11, 14], 6000: [16, 20], 3000: [8, 10] };

/** Long edge of the finished gallery JPEG, matching public/images/tributes/. */
const GALLERY_WIDTH = 1100;

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`${res.statusCode} for ${url}`));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

async function printBufferFor(orderId) {
  if (SRC_DIR) {
    const local = path.join(SRC_DIR, `${orderId}.jpg`);
    if (!fs.existsSync(local)) throw new Error(`missing ${local}`);
    return fs.readFileSync(local);
  }
  return fetchBuffer(`${BASE}/output/print-ready/${orderId}.jpg`);
}

async function main() {
  const spec = arg('orders', '');
  if (!spec) {
    console.error('Need --orders=<orderId>:<slug>[,<orderId>:<slug>...]');
    process.exit(1);
  }
  const targets = spec.split(',').map((pair) => {
    const [orderId, slug] = pair.split(':');
    if (!orderId || !slug) throw new Error(`bad --orders entry: ${pair}`);
    return { orderId: orderId.trim(), slug: slug.trim() };
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sharp = require('sharp');

  for (let i = 0; i < targets.length; i++) {
    const { orderId, slug } = targets[i];
    const print = await printBufferFor(orderId);
    const meta = await sharp(print).metadata();
    const longEdge = Math.max(meta.width, meta.height);
    const sizeIn = SIZE_BY_LONG_EDGE[longEdge];
    if (!sizeIn) throw new Error(`unrecognised print size ${meta.width}x${meta.height} for ${orderId}`);

    // Alternate wall tone exactly as the demo batch does, so a real piece
    // dropped between two demos does not read as a different wall.
    const { buffer, piece } = await frameOnWall(print, 'black', WALLS[i % WALLS.length], sizeIn);

    // Down to the same 1100px long edge the committed demo pieces use. The
    // gallery is a three-column masonry, so a piece renders around 370px wide;
    // 1100 covers 3x displays and nothing beyond that is doing any work.
    const out = await sharp(buffer)
      .resize(GALLERY_WIDTH)
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();

    const file = path.join(OUT_DIR, `${slug}.jpg`);
    fs.writeFileSync(file, out);
    const dims = await sharp(out).metadata();
    console.log(
      `  ${slug.padEnd(10)} ${sizeIn.join('x').padEnd(6)} -> ${path.basename(file)} ` +
      `${dims.width}x${dims.height} (${Math.round(out.length / 1024)}KB)`
    );
    void piece;
  }
  console.log(`\nDone. ${targets.length} image(s) in ${OUT_DIR}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
