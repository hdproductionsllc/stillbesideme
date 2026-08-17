#!/usr/bin/env node
/**
 * Write the honest AggregateRating into the static pages, computed from
 * src/data/reviews.json rather than typed by hand.
 *
 * Why this is a build step. The rating has to be in the raw HTML: a crawler
 * that never runs our JavaScript still has to see the real figure, and a number
 * injected at runtime is a number Google may not read. But the moment a mean is
 * typed into six separate pages it starts to drift, and a drifting rating on a
 * memorial business is not a cosmetic problem. So the number is derived here,
 * from the same legacyRatings block the runtime helper uses, and written into
 * every page in one pass.
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
// in one of them cannot quietly publish a wrong rating to six live pages.
const five = Number(legacy.fiveStar) || 0;
const four = Number(legacy.fourStar) || 0;
if (five + four === count && five * 5 + four * 4 !== total) {
  console.error(`legacyRatings is inconsistent: ${five}x5 + ${four}x4 = ${five * 5 + four * 4}, but total says ${total}.`);
  process.exit(1);
}

const mean = Math.round((total / count) * 10) / 10;
const ratingValue = mean.toFixed(1);

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
for (const file of fs.readdirSync(PUBLIC_DIR).filter(f => f.endsWith('.html'))) {
  const full = path.join(PUBLIC_DIR, file);
  const before = fs.readFileSync(full, 'utf8');

  let after = before;
  if (BLOCK.test(after)) {
    BLOCK.lastIndex = 0;
    after = after.replace(BLOCK, (m, a, oldRating, b, oldCount, c) => {
      if (oldRating !== ratingValue || oldCount !== String(count)) {
        console.log(`  ${file}: schema ${oldRating}/${oldCount} -> ${ratingValue}/${count}`);
      }
      return a + ratingValue + b + count + c;
    });
  }
  VISIBLE.lastIndex = 0;
  after = after.replace(VISIBLE, (m, open, tag, inner, close) => open + visibleInner + close);

  if (after !== before) { fs.writeFileSync(full, after); touched++; }
}

console.log(`Review aggregate: ${ratingValue} from ${count} reviews (${total} points). Pages updated: ${touched}.`);
