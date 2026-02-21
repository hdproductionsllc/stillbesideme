/**
 * WHCC Catalog Service
 * Caches catalog data with 24-hour TTL, manages SKU → WHCC product mapping.
 * Shared by both Order Submit API and Editor API.
 */

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get cached catalog or fetch fresh if stale.
 * @param {'order'|'editor'} type - Which catalog to fetch
 * @param {object} db - Database instance
 * @param {function} fetchFn - Async function that returns raw catalog data
 */
async function getCatalog(type, db, fetchFn) {
  const cached = db.get(
    'SELECT data_json, fetched_at FROM whcc_catalog WHERE catalog_type = ?',
    [type]
  );

  if (cached) {
    const age = Date.now() - new Date(cached.fetched_at + 'Z').getTime();
    if (age < CACHE_TTL_MS) {
      return JSON.parse(cached.data_json);
    }
  }

  return refreshCatalog(type, db, fetchFn);
}

/**
 * Force-refresh catalog from WHCC API.
 */
async function refreshCatalog(type, db, fetchFn) {
  const data = await fetchFn();
  const json = JSON.stringify(data);

  const existing = db.get(
    'SELECT id FROM whcc_catalog WHERE catalog_type = ?',
    [type]
  );

  if (existing) {
    db.run(
      'UPDATE whcc_catalog SET data_json = ?, fetched_at = datetime(\'now\') WHERE catalog_type = ?',
      [json, type]
    );
  } else {
    db.run(
      'INSERT INTO whcc_catalog (catalog_type, data_json) VALUES (?, ?)',
      [type, json]
    );
  }

  return data;
}

/**
 * Get our SKU → WHCC product mapping.
 */
function getProductMapping(sku, db) {
  const row = db.get('SELECT * FROM whcc_product_map WHERE sku = ?', [sku]);
  if (!row) return null;
  return {
    ...row,
    whcc_attribute_uids: row.whcc_attribute_uids ? JSON.parse(row.whcc_attribute_uids) : []
  };
}

/**
 * List all product mappings.
 */
function getAllMappings(db) {
  return db.all('SELECT * FROM whcc_product_map ORDER BY sku').map(row => ({
    ...row,
    whcc_attribute_uids: row.whcc_attribute_uids ? JSON.parse(row.whcc_attribute_uids) : []
  }));
}

/**
 * Set a SKU → WHCC product mapping.
 */
function setProductMapping(db, { sku, productUid, nodeId, attributeUids, description }) {
  const existing = db.get('SELECT sku FROM whcc_product_map WHERE sku = ?', [sku]);
  const attrsJson = JSON.stringify(attributeUids || []);

  if (existing) {
    db.run(
      `UPDATE whcc_product_map
       SET whcc_product_uid = ?, whcc_node_id = ?, whcc_attribute_uids = ?,
           description = ?, updated_at = datetime('now')
       WHERE sku = ?`,
      [productUid, nodeId, attrsJson, description || null, sku]
    );
  } else {
    db.run(
      `INSERT INTO whcc_product_map (sku, whcc_product_uid, whcc_node_id, whcc_attribute_uids, description)
       VALUES (?, ?, ?, ?, ?)`,
      [sku, productUid, nodeId, attrsJson, description || null]
    );
  }
}

/**
 * Scan WHCC catalog for products matching our print sizes.
 * Returns suggested mappings for review.
 */
function autoMapProducts(catalogData, db) {
  // Our SKU patterns: framed-8x10, framed-11x14, framed-16x20, framed-20x24
  const ourSizes = [
    { sku: 'framed-8x10', width: 8, height: 10 },
    { sku: 'framed-11x14', width: 11, height: 14 },
    { sku: 'framed-16x20', width: 16, height: 20 },
    { sku: 'framed-20x24', width: 20, height: 24 }
  ];

  const suggestions = [];

  if (!catalogData || !Array.isArray(catalogData)) {
    return suggestions;
  }

  for (const size of ourSizes) {
    const sizeStr = `${size.width}x${size.height}`;
    const altStr = `${size.width} x ${size.height}`;
    const matches = [];

    // Walk catalog looking for size matches in product names/descriptions
    for (const product of catalogData) {
      const name = (product.Name || product.name || '').toLowerCase();
      const desc = (product.Description || product.description || '').toLowerCase();
      const searchable = `${name} ${desc}`;

      if (searchable.includes(sizeStr) || searchable.includes(altStr)) {
        matches.push({
          productUid: product.ProductUID || product.productUid || product.id,
          name: product.Name || product.name,
          description: product.Description || product.description
        });
      }
    }

    const existing = getProductMapping(size.sku, db);

    suggestions.push({
      sku: size.sku,
      currentMapping: existing,
      candidates: matches
    });
  }

  return suggestions;
}

module.exports = {
  getCatalog,
  refreshCatalog,
  getProductMapping,
  getAllMappings,
  setProductMapping,
  autoMapProducts
};
