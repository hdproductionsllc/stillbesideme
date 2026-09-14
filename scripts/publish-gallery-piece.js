/**
 * Publish a real customer tribute to the homepage gallery, or take it down.
 *
 * Terms of Service section 5 tells a customer that if they would rather we did
 * not show their piece, we take it down and they do not have to give a reason.
 * This is the tool that keeps that promise:
 *
 *   node scripts/publish-gallery-piece.js --order=<id> --slug=bug
 *   node scripts/publish-gallery-piece.js --order=<id> --unpublish
 *   node scripts/publish-gallery-piece.js --list
 *
 * It talks to the running site over HTTP and does NOT touch store.db directly.
 * That is not a stylistic choice. sql.js holds the entire database in memory
 * and flushes it to disk on a debounce, so a second process editing the file is
 * invisible to the live server and is then silently overwritten by the server's
 * next write. A takedown that reverts itself an hour later is the one failure
 * this tool cannot have, so the running app stays the only writer.
 *
 * Config, from flags or the environment:
 *   --base=   site URL            (default http://localhost:3001, or SITE_URL)
 *   --pass=   admin password      (default ADMIN_PASSWORD)
 *
 * Against production, with the password from the Railway environment:
 *   node scripts/publish-gallery-piece.js --base=https://www.stillbesideme.com \
 *     --pass="$ADMIN_PASSWORD" --order=<id> --slug=bug
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const arg = (name) => {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes('=') ? hit.slice(name.length + 3) : true;
};

const BASE = arg('base') || process.env.SITE_URL || 'http://localhost:3001';
const PASS = arg('pass') || process.env.ADMIN_PASSWORD;

/** One request. Returns { status, body, cookies }. */
function request(method, url, { body, contentType, cookie } = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const payload = body == null ? null : Buffer.from(body);
  const headers = {};
  if (payload) {
    headers['Content-Type'] = contentType;
    headers['Content-Length'] = payload.length;
  }
  if (cookie) headers.Cookie = cookie;

  return new Promise((resolve, reject) => {
    const req = mod.request(
      { method, hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const setCookie = res.headers['set-cookie'] || [];
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            cookies: setCookie.map((c) => c.split(';')[0]).join('; '),
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Sign in and return the session cookie the gated endpoints need. */
async function login() {
  if (!PASS) {
    console.error('No admin password. Pass --pass=... or set ADMIN_PASSWORD.');
    process.exit(1);
  }
  const res = await request('POST', `${BASE}/admin/login`, {
    body: `password=${encodeURIComponent(PASS)}`,
    contentType: 'application/x-www-form-urlencoded',
  });
  if (res.status !== 302 || !res.cookies) {
    console.error(`Admin sign-in failed (HTTP ${res.status}). Wrong password, or ADMIN_PASSWORD is not set on the server.`);
    process.exit(1);
  }
  return res.cookies;
}

function parse(res) {
  try {
    return JSON.parse(res.body);
  } catch (e) {
    return { error: `Unexpected reply (HTTP ${res.status})` };
  }
}

async function main() {
  const cookie = await login();

  if (arg('list')) {
    const res = await request('GET', `${BASE}/admin/api/gallery`, { cookie });
    const data = parse(res);
    if (!data.pieces || !data.pieces.length) {
      console.log('\nNothing published to the gallery.\n');
      return;
    }
    console.log('\nPublished gallery pieces:\n');
    data.pieces.forEach((p) => {
      console.log(`  ${String(p.gallery_slug).padEnd(12)} ${p.id}  ${String(p.status).padEnd(14)} ${p.gallery_published_at || ''}`);
    });
    console.log('');
    return;
  }

  const orderId = arg('order');
  if (!orderId || orderId === true) {
    console.error('Need --order=<id>, plus --slug=<slug> or --unpublish. Or --list.');
    process.exit(1);
  }

  if (arg('unpublish')) {
    const res = await request('POST', `${BASE}/admin/api/orders/${encodeURIComponent(orderId)}/gallery/unpublish`, { cookie });
    const data = parse(res);
    if (res.status !== 200) {
      console.error(data.error || `Failed (HTTP ${res.status})`);
      process.exit(1);
    }
    if (data.alreadyDown) {
      console.log(`Order ${orderId} was not published. Nothing to do.`);
      return;
    }
    console.log(`\nTaken down: ${data.slug}`);
    console.log('It is off the site now. Delete the image from the volume too:');
    console.log(`  railway ssh "rm /data/output/${data.deleteFile}"\n`);
    return;
  }

  const slug = arg('slug');
  if (!slug || slug === true) {
    console.error('Need --slug=<slug> (or --unpublish).');
    process.exit(1);
  }

  const res = await request('POST', `${BASE}/admin/api/orders/${encodeURIComponent(orderId)}/gallery/publish`, {
    cookie,
    body: JSON.stringify({ slug }),
    contentType: 'application/json',
  });
  const data = parse(res);
  if (res.status !== 200) {
    console.error(data.error || `Failed (HTTP ${res.status})`);
    process.exit(1);
  }
  console.log(`\nPublished ${orderId} as "${data.slug}".`);
  console.log(`  URL: ${data.url}`);
  console.log('  Make sure the image is on the volume at /data/output' + data.url + '\n');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
