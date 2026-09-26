/**
 * USPS parcel tracking (free USPS APIs, Tracking 3.2).
 *
 * Exists because the printer cannot tell us a parcel ARRIVED. Luma's only
 * webhook is `shipping`, and neither its order nor its shipment lookup carries
 * a delivered status or date (checked against their API docs, Sept 2026). The
 * carrier is the only party that knows, and every real Luma parcel so far has
 * gone USPS Ground Advantage.
 *
 * Credentials: USPS_CONSUMER_KEY / USPS_CONSUMER_SECRET, the Consumer Key and
 * Consumer Secret of the "Still Beside Me delivery check" app in the USPS
 * Customer Onboarding Portal (cop.usps.com → My Apps). Without them
 * isConfigured() is false and the delivery check does nothing, which in turn
 * means no review invite goes out: an unconfirmed delivery is never asked about.
 *
 * Tracking 3.2 (spec: developers.usps.com/trackingv3r2) takes up to 35
 * tracking numbers in ONE request and answers per parcel, so a day's check is
 * normally a single call. That matters: free access is capped at roughly 60
 * requests an hour across every endpoint, token requests included, so the
 * token is also cached for its lifetime.
 */

const API_BASE = 'https://apis.usps.com';
const TRACKING_URL = `${API_BASE}/tracking/v3r2/tracking`;

// Tracking 3.2 accepts between 1 and 35 tracking numbers per request.
const MAX_PER_REQUEST = 35;

// Refresh a little before USPS says the token dies, so a lookup never races it.
const TOKEN_SAFETY_MS = 5 * 60 * 1000;

let cachedToken = null; // { value, expiresAt }

function isConfigured() {
  return Boolean(process.env.USPS_CONSUMER_KEY && process.env.USPS_CONSUMER_SECRET);
}

/** True when this carrier name is one USPS can answer for. */
function handlesCarrier(carrier) {
  return /usps|postal/i.test(String(carrier || ''));
}

async function getToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const res = await fetch(`${API_BASE}/oauth2/v3/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.USPS_CONSUMER_KEY,
      client_secret: process.env.USPS_CONSUMER_SECRET,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const err = new Error(`USPS token request failed (${res.status}): ${body.error_description || body.error || 'no token returned'}`);
    err.status = res.status;
    throw err;
  }

  const lifetimeMs = (Number(body.expires_in) || 3600) * 1000;
  cachedToken = {
    value: body.access_token,
    expiresAt: Date.now() + Math.max(lifetimeMs - TOKEN_SAFETY_MS, 60 * 1000),
  };
  return cachedToken.value;
}

/**
 * Turn one parcel's USPS tracking detail into the only three things the
 * business cares about. Pure, so the rules can be tested against recorded
 * responses.
 *
 * Returned is checked BEFORE delivered: USPS reports a parcel that went back
 * to us as "Delivered, To Original Sender", and that family has no piece to
 * review.
 *
 * @returns {{state: 'delivered'|'returned'|'in_transit', deliveredAt: string|null, status: string}}
 */
function classify(detail) {
  const t = detail || {};
  // Events are newest first (per the spec).
  const events = Array.isArray(t.trackingEvents) ? t.trackingEvents : [];
  const latest = events[0] || {};
  const status = String(t.status || latest.eventType || t.statusSummary || '').trim();
  const category = String(t.statusCategory || '').trim();
  const headline = `${category} ${status} ${latest.eventType || ''}`;

  if (/return(ed)? to sender|to original sender|undeliverable|refused/i.test(headline)) {
    return { state: 'returned', deliveredAt: null, status: status || category };
  }

  if (/^delivered/i.test(category) || /^delivered/i.test(status)) {
    const deliveryEvent = events.find(e => /^delivered/i.test(String(e.eventType || '')));
    // GMTTimestamp is true UTC; eventTimestamp is local time at the door.
    // Prefer the first, fall back to the second.
    const deliveredAt = deliveryEvent
      ? (deliveryEvent.GMTTimestamp || deliveryEvent.eventTimestamp || null)
      : null;
    return { state: 'delivered', deliveredAt, status: status || category };
  }

  return { state: 'in_transit', deliveredAt: null, status: status || category };
}

/**
 * Ask USPS about several parcels at once.
 *
 * Answers per parcel, in a Map keyed by tracking number:
 *   { state, deliveredAt, status }   an answer
 *   { error }                        USPS could not answer for that parcel today
 *
 * A number USPS does not know yet (label printed, not scanned) comes back as
 * "404" for that parcel, which is simply still in transit from our point of
 * view. A failure of the whole request (sign-in, rate limit, outage) throws,
 * with err.status set, so the caller can stop for the day.
 */
async function trackMany(trackingNumbers) {
  const results = new Map();
  const unique = [...new Set(trackingNumbers.filter(Boolean).map(String))];

  for (let i = 0; i < unique.length; i += MAX_PER_REQUEST) {
    const chunk = unique.slice(i, i + MAX_PER_REQUEST);
    const token = await getToken();
    const res = await fetch(TRACKING_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(chunk.map(trackingNumber => ({ trackingNumber }))),
    });

    if (res.status === 401) cachedToken = null; // let the next run fetch a fresh one

    const body = await res.json().catch(() => null);
    // 200 = every parcel answered, 207 = a mix of answers and per-parcel errors.
    if ((res.status !== 200 && res.status !== 207) || !Array.isArray(body)) {
      const detail = body && body.error ? (body.error.message || JSON.stringify(body.error)) : '';
      const err = new Error(`USPS tracking request failed (${res.status})${detail ? `: ${detail}` : ''}`);
      err.status = res.status;
      throw err;
    }

    for (const item of body) {
      const number = String((item && item.trackingNumber) || '');
      if (!number) continue;
      const code = String(item.statusCode || '200');
      if (code === '200') {
        results.set(number, classify(item));
      } else if (code === '404') {
        results.set(number, { state: 'in_transit', deliveredAt: null, status: 'Not yet in the USPS system' });
      } else {
        const message = (item.error && item.error.message) || `status ${code}`;
        results.set(number, { error: message });
      }
    }

    // A parcel USPS left out of its answer is one we learned nothing about.
    for (const number of chunk) {
      if (!results.has(number)) results.set(number, { error: 'no answer for this parcel' });
    }
  }

  return results;
}

/** Test seam: forget the cached token. */
function _resetToken() { cachedToken = null; }

module.exports = { isConfigured, handlesCarrier, classify, trackMany, MAX_PER_REQUEST, _resetToken };
