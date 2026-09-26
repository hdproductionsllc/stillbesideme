/**
 * Ask USPS about one real parcel, exactly as the daily delivery check would,
 * and print what it would conclude. Read-only: writes nothing, emails no one.
 *
 * Use it once after putting USPS_CONSUMER_KEY / USPS_CONSUMER_SECRET in .env,
 * with the tracking number of a parcel you know has been delivered:
 *
 *   node scripts/check-usps-tracking.js 9400100000000000000000
 *
 * Expect "delivered" and a delivery time. Anything else (a sign-in error, or
 * "in_transit" for a parcel you know arrived) means the check is not ready to
 * be trusted with review invites yet.
 */

require('dotenv').config();
const usps = require('../src/services/uspsTracking');

(async () => {
  const number = process.argv[2];
  if (!number) {
    console.error('Usage: node scripts/check-usps-tracking.js <USPS tracking number>');
    process.exit(1);
  }
  if (!usps.isConfigured()) {
    console.error('USPS_CONSUMER_KEY and USPS_CONSUMER_SECRET are not set in .env');
    process.exit(1);
  }

  // Show the raw answer too, so a surprising verdict can be traced to its cause.
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const res = await realFetch(url, opts);
    if (url.includes('/tracking')) {
      const text = await res.clone().text();
      console.log(`USPS answered ${res.status}:\n${text.slice(0, 2000)}\n`);
    }
    return res;
  };

  try {
    const answers = await usps.trackMany([number]);
    console.log('Verdict:', answers.get(number));
  } catch (err) {
    console.error('Lookup failed:', err.message);
    process.exit(1);
  }
})();
