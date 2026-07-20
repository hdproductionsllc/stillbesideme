#!/usr/bin/env node
/**
 * Write src/data/lastmod.json — the real last-content-change date for each public
 * page, taken from git.
 *
 * Why this is a build step and not a runtime lookup: the sitemap needs honest
 * lastmod dates, but neither source is available in the Railway container.
 * File mtime is the deploy timestamp (every deploy re-checks-out the repo, so
 * all pages report the same date and it changes even when nothing changed —
 * the exact pattern Google learns to distrust). And `git` isn't installed in
 * the runtime image, so server.js can't shell out for it either.
 *
 * So we resolve the dates here, where git exists, and commit the result.
 * server.js prefers this manifest, falls back to a live git call for local
 * dev, and omits lastmod entirely if neither works.
 *
 * Run after editing page content:  npm run lastmod
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'src', 'data', 'lastmod.json');

function gitDate(relPath) {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%cs', '--', `public/${relPath}`], {
      cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch (e) {
    return null;
  }
}

const pages = [
  ...fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html')),
  ...fs.readdirSync(path.join(PUBLIC_DIR, 'blog'))
    .filter(f => f.endsWith('.html')).map(f => `blog/${f}`),
];

const manifest = {};
let resolved = 0;
for (const p of pages) {
  const d = gitDate(p);
  if (d) { manifest[p] = d; resolved++; }
}

if (resolved === 0) {
  console.error('build-lastmod: git returned no dates — manifest NOT written.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(manifest, null, 2) + '\n');
console.log(`build-lastmod: wrote ${resolved} dates to src/data/lastmod.json`);
