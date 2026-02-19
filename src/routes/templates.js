/**
 * Template routes — serves the single pet-tribute template.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'templates', 'pet-tribute.json');

let templateCache = null;

function loadTemplate() {
  if (templateCache) return templateCache;
  const raw = fs.readFileSync(TEMPLATE_PATH, 'utf-8');
  templateCache = JSON.parse(raw);
  console.log(`  Loaded template: ${templateCache.id}`);
  return templateCache;
}

/**
 * GET /api/templates — Returns the single template summary
 */
router.get('/', (req, res) => {
  const t = loadTemplate();
  res.json([{
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    poemSupport: t.poemSupport,
    startingPrice: Math.min(...t.printProducts.map(p => p.price)),
    styleVariants: Object.keys(t.styleVariants)
  }]);
});

/**
 * GET /api/templates/:id — Full template definition
 */
router.get('/:id', (req, res) => {
  const template = loadTemplate();

  if (req.params.id !== template.id) {
    return res.status(404).json({ error: 'Template not found' });
  }

  res.json(template);
});

module.exports = router;
