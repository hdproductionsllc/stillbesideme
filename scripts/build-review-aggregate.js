#!/usr/bin/env node
/**
 * Write the honest AggregateRating into the static pages, computed from
 * src/data/reviews.json rather than typed by hand.
 *
 * Why this is a build step. The rating has to be in the raw HTML: a crawler
 * that never runs our JavaScript still has to see the real figure, and a number
 * injected at runtime is a number Google may not read. But the moment a mean is
 * typed by hand it starts to drift, and a drifting rating on a memorial business
 * is not a cosmetic problem. So the number is derived here, from the same
 * legacyRatings block the runtime helper uses, and written in one pass.
 *
 * There are TWO places it goes, and they no longer line up one-to-one:
 *
 *   1. The schema aggregateRating. Exactly ONE page carries a Product node —
 *      public/index.html, the canonical product page. The five landing pages
 *      (pet-/dog-/cat-memorial-gifts, memorial-gifts, sympathy-gifts) used to
 *      declare their own duplicate Product, which told Google there were six
 *      products instead of one; they now carry FAQPage + BreadcrumbList only.
 *      So a page with no aggregateRating block is the normal case, not a
 *      failure — but the canonical page losing its block IS a failure, and
 *      this script fails loudly on that rather than quietly writing nothing.
 *
 *   2. The visible figure (any element with data-customer-rating), which is
 *      still on all six pages. Visible copy is not a duplicate product
 *      entity, so it stays everywhere the social-proof section appears.
 *
 * Per-review star ratings are deliberately absent everywhere: ratings were
 * collected from these 30 customers, but the score-to-person mapping was not
 * retained, so no named review can be given a rating and no schema Review
 * nodes are published. Only the aggregate, which is backed by real counts.
 *
 * This writes the LEGACY baseline only. Once real reviews are published through
 * the moderation queue, public/js/customer-reviews.js recomputes the combined
 * figure in the browser and overwrites what this script wrote. Re-run this after
 * any change to legacyRatings, and after publishing reviews if you want the
 * static baseline to catch up:
 *
 *   npm run review-aggregate
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const catalogue = require(path.join(ROOT, 'src', 'data', 'reviews.json'));

const legacy = catalogue.legacyRatings || {};
const count = Number(legacy.count) || 0;
const total = Number(legacy.total) || 0;

if (!count || !total) {
  console.error('reviews.json has no usable legacyRatings block. Nothing written.');
  process.exit(1);
}

// Cross-check the declared distribution against the declared total, so a typo
// in one of them cannot quietly publish a wrong rating to the live pages.
const five = Number(legacy.fiveStar) || 0;
const four = Number(legacy.fourStar) || 0;
if (five + four === count && five * 5 + four * 4 !== total) {
  console.error(`legacyRatings is inconsistent: ${five}x5 + ${four}x4 = ${five * 5 + four * 4}, but total says ${total}.`);
  process.exit(1);
}

const mean = Math.round((total / count) * 10) / 10;
const ratingValue = mean.toFixed(1);

// The one page that carries the Product node, and therefore the only page that
// must contain a schema aggregateRating. Absence here is a regression.
const CANONICAL = 'index.html';

const BLOCK = new RegExp(
  '("aggregateRating"\\s*:\\s*\\{[\\s\\S]*?"ratingValue"\\s*:\\s*")([^"]*)("[\\s\\S]*?"reviewCount"\\s*:\\s*")([^"]*)(")',
  'g'
);

// The visible figure, so the same computed number reaches a reader with
// JavaScript switched off. Matches the inner markup of any element carrying
// data-customer-rating and rewrites it wholesale.
// The closing tag is matched by BACKREFERENCE, not by "any close tag": the
// inner markup contains <span>s, and a naive \/[a-z]+ closes on the first one
// and shreds the element.
const VISIBLE = /(<([a-z]+)[^>]*\sdata-customer-rating[^>]*>)([\s\S]*?)(<\/\2>)/gi;
const stars = '★'.repeat(Math.round(mean)) + '☆'.repeat(5 - Math.round(mean));
const visibleInner = '\n            <span class="cr-stars" aria-hidden="true">' + stars + '</span>'
  + '\n            <span class="cr-score">' + ratingValue + ' out of 5</span>'
  + '\n            <span class="cr-count">from ' + count + ' review' + (count === 1 ? '' : 's') + '</span>'
  + '\n          ';

let touched = 0;
let schemaPages = 0;   // pages that carried a schema aggregateRating at all
let visiblePages = 0;  // pages that carried a visible data-customer-rating
let canonicalSeen = false;
let canonicalHadSchema = false;

for (const file of fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'))) {
  const full = path.join(PUBLIC_DIR, file);
  const before = fs.readFileSync(full, 'utf8');
  if (file === CANONICAL) canonicalSeen = true;

  // Both regexes are global, so reset lastIndex before every use and let
  // .replace() report whether it matched — never .test() on a /g regex, whose
  // lastIndex leaks into the next call and makes it skip or re-scan.
  let after = before;
  let schemaHits = 0;
  BLOCK.lastIndex = 0;
  after = after.replace(BLOCK, (m, a, oldRating, b, oldCount, c) => {
    schemaHits++;
    if (oldRating !== ratingValue || oldCount !== String(count)) {
      console.log(`  ${file}: schema ${oldRating}/${oldCount} -> ${ratingValue}/${count}`);
    }
    return a + ratingValue + b + count + c;
  });
  if (schemaHits) schemaPages++;
  if (file === CANONICAL && schemaHits) canonicalHadSchema = true;

  let visibleHits = 0;
  VISIBLE.lastIndex = 0;
  after = after.replace(VISIBLE, (m, open, tag, inner, close) => {
    visibleHits++;
    return open + visibleInner + close;
  });
  if (visibleHits) visiblePages++;

  if (after !== before) { fs.writeFileSync(full, after); touched++; }
}

console.log(`Review aggregate: ${ratingValue} from ${count} reviews (${total} points).`);
console.log(`  schema aggregateRating found on ${schemaPages} page(s) (expected: 1, ${CANONICAL});`
  + ` visible rating found on ${visiblePages} page(s). Files rewritten: ${touched}.`);

// A page without an aggregateRating is normal now — only the canonical product
// page has one. But if THAT page has lost it, this script has silently written
// the rating nowhere, which is exactly the failure it exists to prevent.
if (!canonicalSeen) {
  console.error(`${CANONICAL} is missing from ${PUBLIC_DIR}. No schema rating could be written.`);
  process.exit(1);
}
if (!canonicalHadSchema) {
  console.error(`${CANONICAL} has no "aggregateRating" block in its Product JSON-LD, so no schema`
    + ' rating was written. Restore it on the canonical product page, or move CANONICAL in this'
    + ' script to whichever page now carries the Product node.');
  process.exit(1);
}
if (schemaPages > 1) {
  console.warn(`Warning: ${schemaPages} pages carry a schema aggregateRating. Only ${CANONICAL}`
    + ' should declare a Product; duplicate Product entities tell Google there are several'
    + ' products when there is one.');
}
if (!visiblePages) {
  console.warn('Warning: no element with data-customer-rating was found, so the rating is not'
    + ' visible in the raw HTML on any page. Google requires the figure to be on the page.');
}
