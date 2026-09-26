/**
 * Carrier-confirmed delivery.
 *
 * Once a day, just before the review invite engine runs (server.js), this asks
 * the carrier about every parcel that has shipped but has not yet been seen
 * arriving, and records what it learns in order_events:
 *
 *   carrier_delivered  created_at = the carrier's delivery time. This is the
 *                      clock the review invite engine starts from.
 *   carrier_returned   the parcel went back (refused, undeliverable, return to
 *                      sender). That family has no piece, so they are never
 *                      asked for a review, and David gets one alert to reach
 *                      out personally.
 *
 * Why a carrier and not the printer: Luma's API has no delivery status at all.
 *
 * A parcel is only checked for CHECK_WITHIN_DAYS after it shipped. One the
 * carrier never confirms in that time is never recorded as delivered, so it is
 * never asked about. That is deliberate (David, Sept 26 2026): an honest
 * silence beats asking a grieving family how a piece looks that may not have
 * reached them.
 *
 * Only USPS is wired today, because it is the carrier Luma actually uses. A
 * parcel on another carrier is left alone (and so never asked about) until a
 * lookup for that carrier is added here.
 */

const usps = require('./uspsTracking');
const { trackingForOrder } = require('./orderTracking');

// How long after shipping we keep asking the carrier. Ground parcels land in
// under a week; three more weeks covers every realistic delay.
const CHECK_WITHIN_DAYS = 30;

// USPS allows roughly 60 requests an hour across every endpoint, and one
// request covers 35 parcels. Ten requests' worth leaves ample room for the
// token and for a restart re-running the check in the same hour. Anything past
// the budget is simply checked tomorrow, oldest shipment first so nothing
// starves.
const MAX_LOOKUPS_PER_RUN = usps.MAX_PER_REQUEST * 10;

// Whichever provider fulfilled it, the shipping event is when checking starts.
const SHIPPED_EVENTS = ['luma_shipped', 'partner_shipped', 'whcc_shipped'];

let warnedUnconfigured = false;

/**
 * checkDeliveries()
 *
 * @returns {Promise<{delivered,returned,pending,unsupported,failed}>}
 */
async function checkDeliveries() {
  const summary = { delivered: 0, returned: 0, pending: 0, unsupported: 0, failed: 0 };

  if (!usps.isConfigured()) {
    if (!warnedUnconfigured) {
      console.warn('Delivery engine: USPS_CONSUMER_KEY/USPS_CONSUMER_SECRET not set, so no delivery can be confirmed and no review invite will go out');
      warnedUnconfigured = true;
    }
    return summary;
  }

  const db = await require('../db/database').init();
  const placeholders = SHIPPED_EVENTS.map(() => '?').join(',');

  // MIN(created_at): a provider can re-deliver its shipping webhook, and the
  // first one is the true ship date.
  const candidates = db.all(
    `SELECT o.*, s.shipped_at
       FROM orders o
       JOIN (SELECT order_id, MIN(created_at) AS shipped_at
               FROM order_events
              WHERE event_type IN (${placeholders})
              GROUP BY order_id) s
         ON s.order_id = o.id
      WHERE julianday('now') - julianday(s.shipped_at) <= ?
        AND NOT EXISTS (SELECT 1 FROM order_events e
                         WHERE e.order_id = o.id
                           AND e.event_type IN ('carrier_delivered', 'carrier_returned'))
      ORDER BY s.shipped_at ASC`,
    [...SHIPPED_EVENTS, CHECK_WITHIN_DAYS]
  );

  // Gather today's parcels first, then ask USPS about all of them together.
  const toCheck = [];
  for (const order of candidates) {
    const tracking = trackingForOrder(db, order);
    if (!tracking || !usps.handlesCarrier(tracking.carrier)) {
      summary.unsupported++;
    } else if (toCheck.length >= MAX_LOOKUPS_PER_RUN) {
      summary.pending++;
    } else {
      toCheck.push({ order, tracking });
    }
  }
  if (!toCheck.length) {
    console.log(`Delivery engine: nothing to check (unsupported=${summary.unsupported})`);
    return summary;
  }

  let answers;
  try {
    answers = await usps.trackMany(toCheck.map(p => p.tracking.number));
  } catch (err) {
    // Sign-in, rate limit or outage: nothing learned today, tomorrow tries again.
    console.error('Delivery engine: USPS lookup failed:', err.message);
    summary.failed += toCheck.length;
    return summary;
  }

  for (const { order, tracking } of toCheck) {
    const result = answers.get(String(tracking.number));
    if (!result || result.error) {
      console.error(`Delivery engine: no USPS answer for order ${order.id}: ${result ? result.error : 'missing'}`);
      summary.failed++;
      continue;
    }

    if (result.state === 'delivered') {
      // The carrier's own delivery time when it gives one. datetime() turns
      // any ISO form (with or without an offset) into the stored UTC shape;
      // an unparseable one falls back to now, which only delays the ask.
      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json, created_at)
         VALUES (?, 'carrier_delivered', ?, COALESCE(datetime(?), datetime('now')))`,
        [order.id, JSON.stringify({ carrier: tracking.carrier, trackingNumber: tracking.number, status: result.status, deliveredAt: result.deliveredAt }), result.deliveredAt]
      );
      summary.delivered++;
      console.log(`Delivery engine: order ${order.id} delivered (${result.status})`);
    } else if (result.state === 'returned') {
      db.run(
        `INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, 'carrier_returned', ?)`,
        [order.id, JSON.stringify({ carrier: tracking.carrier, trackingNumber: tracking.number, status: result.status })]
      );
      summary.returned++;
      console.warn(`Delivery engine: order ${order.id} is going back to sender (${result.status})`);
      try {
        await require('./emailService').sendAdminAlert(
          `Parcel returned — order ${order.id.substring(0, 8).toUpperCase()}`,
          `${tracking.carrier} reports that the parcel for order ${order.id} is not reaching the customer.\n\n`
          + `Carrier status: ${result.status}\n`
          + `Tracking: ${tracking.number}${tracking.url ? `\n${tracking.url}` : ''}\n`
          + `Customer: ${order.email || '(no email on file)'}\n\n`
          + `This family will not be asked for a review. They may need a reprint or a call.`
        );
      } catch (err) {
        console.error(`Delivery engine: could not send return alert for order ${order.id}:`, err.message);
      }
    } else {
      summary.pending++;
    }
  }

  console.log(`Delivery engine: delivered=${summary.delivered} returned=${summary.returned} pending=${summary.pending} unsupported=${summary.unsupported} failed=${summary.failed}`);
  return summary;
}

module.exports = { checkDeliveries, CHECK_WITHIN_DAYS, MAX_LOOKUPS_PER_RUN };
