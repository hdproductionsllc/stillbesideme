/**
 * Where an order's parcel tracking lives.
 *
 * Tracking is stored in one of two places depending on who fulfilled the
 * order: partner-fulfilled orders carry it on the orders row itself, Luma
 * orders on their luma_orders row. Everything that needs the number (the
 * customer's status page, the delivery check) asks here, so the two places
 * can never be read differently.
 *
 * @returns {{number, carrier, url}|null}
 */
function trackingForOrder(db, order) {
  // Partner-fulfilled orders carry tracking on the orders row itself
  if (order.tracking_number) {
    return {
      number: order.tracking_number,
      carrier: order.tracking_carrier || '',
      url: order.tracking_url || '',
    };
  }

  const luma = db.get(
    'SELECT tracking_number, tracking_carrier, tracking_url FROM luma_orders WHERE order_id = ? ORDER BY created_at DESC LIMIT 1',
    [order.id]
  );
  if (!luma || !luma.tracking_number) return null;
  return {
    number: luma.tracking_number,
    carrier: luma.tracking_carrier || '',
    url: luma.tracking_url || '',
  };
}

module.exports = { trackingForOrder };
