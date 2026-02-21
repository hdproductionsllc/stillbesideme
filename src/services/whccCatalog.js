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
  const safeNodeId = nodeId || null;

  if (existing) {
    db.run(
      `UPDATE whcc_product_map
       SET whcc_product_uid = ?, whcc_node_id = ?, whcc_attribute_uids = ?,
           description = ?, updated_at = datetime('now')
       WHERE sku = ?`,
      [productUid, safeNodeId, attrsJson, description || null, sku]
    );
  } else {
    db.run(
      `INSERT INTO whcc_product_map (sku, whcc_product_uid, whcc_node_id, whcc_attribute_uids, description)
       VALUES (?, ?, ?, ?, ?)`,
      [sku, productUid, safeNodeId, attrsJson, description || null]
    );
  }
}

/**
 * Flatten WHCC catalog (nested Categories → flat product list).
 * Each product gets its parent category name attached.
 */
function flattenCatalog(catalogData) {
  const products = [];
  const categories = catalogData?.Categories || catalogData?.categories || [];

  if (Array.isArray(categories)) {
    for (const cat of categories) {
      for (const product of (cat.ProductList || [])) {
        products.push({ ...product, categoryName: cat.Name });
      }
    }
  }

  // Fallback: if catalog is already a flat array
  if (products.length === 0 && Array.isArray(catalogData)) {
    return catalogData;
  }

  return products;
}

/**
 * Scan WHCC catalog for products matching our print sizes.
 * Returns suggested mappings for review – prioritizes "Framed Prints" category.
 */
function autoMapProducts(catalogData, db) {
  const ourSizes = [
    { sku: 'framed-8x10', width: 8, height: 10 },
    { sku: 'framed-11x14', width: 11, height: 14 },
    { sku: 'framed-16x20', width: 16, height: 20 },
    { sku: 'framed-20x24', width: 20, height: 24 }
  ];

  const products = flattenCatalog(catalogData);
  const suggestions = [];

  for (const size of ourSizes) {
    const sizeStr = `${size.width}x${size.height}`;
    const matches = [];

    for (const product of products) {
      const name = product.Name || '';
      if (name.includes(sizeStr)) {
        const node = (product.ProductNodes || [])[0];
        matches.push({
          productId: product.Id,
          name,
          category: product.categoryName,
          nodeId: node?.DP2NodeID || null,
          attributeCategories: (product.AttributeCategories || []).map(ac => ({
            name: ac.AttributeCategoryName,
            requiredId: ac.RequiredLevel,
            options: (ac.Attributes || []).slice(0, 3).map(a => a.AttributeName)
          }))
        });
      }
    }

    // Sort: Framed Prints first
    matches.sort((a, b) => {
      if (a.category === 'Framed Prints' && b.category !== 'Framed Prints') return -1;
      if (b.category === 'Framed Prints' && a.category !== 'Framed Prints') return 1;
      return 0;
    });

    suggestions.push({
      sku: size.sku,
      currentMapping: getProductMapping(size.sku, db),
      recommended: matches.find(m => m.category === 'Framed Prints') || matches[0] || null,
      allMatches: matches
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
