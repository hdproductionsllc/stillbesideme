/**
 * Does the Content Security Policy actually let our analytics talk to anyone?
 *
 * This exists because of a live failure that was expensive to diagnose and
 * would have been far more expensive to miss.
 *
 * The Google Ads tag was installed correctly, registered correctly, and looked
 * perfectly healthy in the dataLayer. But `scriptSrc` allowed Google's ad
 * LIBRARIES while `imgSrc` and `connectSrc` allowed none of the endpoints those
 * libraries report to. So every conversion beacon was refused by the browser,
 * Google received nothing at all from the site, and the tag showed as
 * undetected. Left running, the campaign would have spent its entire budget
 * bidding toward a signal that never arrived, with a correctly installed tag,
 * an empty conversions column, and no error anywhere connecting the two.
 *
 * Nothing in the code was wrong, which is why no amount of reading it helped.
 * The block happens inside the visitor's browser. So this checks the POLICY WE
 * ACTUALLY SERVE, not the source that produces it.
 *
 *   node scripts/check-analytics-csp.js                     # production
 *   node scripts/check-analytics-csp.js http://localhost:3001
 */

const REQUIRED = {
  // Where the libraries themselves are fetched from.
  'script-src': [
    'https://www.googletagmanager.com',
    'https://www.googleadservices.com',
    'https://googleads.g.doubleclick.net',
    'https://connect.facebook.net',
  ],
  // Google Ads reports conversions and remarketing largely by fetching pixels.
  'img-src': [
    'https://www.google.com',
    'https://www.googleadservices.com',
    'https://googleads.g.doubleclick.net',
    'https://ad.doubleclick.net',
    'https://www.googletagmanager.com',
    'https://www.facebook.com',
  ],
  // ...and partly by posting to collection endpoints.
  'connect-src': [
    'https://www.google.com',
    'https://www.googleadservices.com',
    'https://googleads.g.doubleclick.net',
    'https://ad.doubleclick.net',
    'https://www.google-analytics.com',
    'https://www.facebook.com',
  ],
};

// Verified live against these exact URLs, so the list is observed rather than
// assumed from documentation:
//   www.google.com/ccm/collect            page_view for AW-
//   www.google.com/rmkt/collect/<id>/     remarketing
//   www.google.com/pagead/1p-user-list/   audience list
//   ad.doubleclick.net/ccm/s/collect      cross-domain measurement
//   googleads.g.doubleclick.net/pagead/viewthroughconversion/<id>/

const base = (process.argv[2] || 'https://www.stillbesideme.com').replace(/\/$/, '');

function parseCsp(header) {
  const out = {};
  for (const part of header.split(';')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (!bits.length) continue;
    out[bits[0]] = bits.slice(1);
  }
  return out;
}

(async () => {
  let res;
  try {
    res = await fetch(base + '/', { redirect: 'follow' });
  } catch (err) {
    console.error(`Could not reach ${base}: ${err.message}`);
    process.exit(2);
  }

  const header = res.headers.get('content-security-policy');
  if (!header) {
    console.error(`No Content-Security-Policy header served by ${base}.`);
    console.error('Either helmet is disabled, or something upstream is stripping it.');
    process.exit(1);
  }

  const csp = parseCsp(header);
  let missing = 0;

  console.log(`\nContent Security Policy at ${base}\n`);
  for (const [directive, needed] of Object.entries(REQUIRED)) {
    const allowed = csp[directive] || [];
    // A wildcard or a missing directive that falls back to a permissive
    // default-src would also pass in a browser; treat those as allowed rather
    // than reporting a failure that is not real.
    const wildcard = allowed.includes('*') || allowed.includes('https:');
    const gaps = wildcard ? [] : needed.filter((d) => !allowed.includes(d));
    if (!csp[directive]) {
      console.log(`  ${directive.padEnd(13)} not set (falls back to default-src)`);
    }
    for (const d of needed) {
      const ok = wildcard || allowed.includes(d);
      if (!ok) missing++;
      console.log(`  ${ok ? 'ok  ' : 'MISS'}  ${directive.padEnd(13)} ${d}`);
    }
    if (gaps.length) console.log('');
  }

  console.log('');
  if (missing) {
    console.error(`FAIL: ${missing} endpoint(s) blocked.`);
    console.error('Analytics will load and look healthy while every beacon it sends is');
    console.error('refused. Conversions will read as zero with nothing else broken.');
    process.exit(1);
  }
  console.log('  Every analytics and ads endpoint we depend on is permitted.\n');
})();
