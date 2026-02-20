/**
 * Template routes – serves all templates from src/data/templates/.
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const TEMPLATES_DIR = path.join(__dirname, '..', 'data', 'templates');

let templateCache = null;

function loadTemplates() {
  if (templateCache) return templateCache;

  templateCache = {};
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const raw = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf-8');
    const tmpl = JSON.parse(raw);
    templateCache[tmpl.id] = tmpl;
    console.log(`  Loaded template: ${tmpl.id}`);
  }

  return templateCache;
}

/**
 * GET /api/templates – Returns array of all template summaries
 */
router.get('/', (req, res) => {
  const cache = loadTemplates();
  const summaries = Object.values(cache).map(t => ({
    id: t.id,
    name: t.name,
    description: t.description,
    collection: t.collection,
    category: t.category,
    poemSupport: t.poemSupport,
    startingPrice: Math.min(...t.printProducts.map(p => p.price)),
    styleVariants: Object.keys(t.styleVariants)
  }));
  res.json(summaries);
});

/**
 * GET /api/templates/:id – Full template definition
 */
router.get('/:id', (req, res) => {
  const cache = loadTemplates();
  const template = cache[req.params.id];

  if (!template) {
    return res.status(404).json({ error: 'Template not found' });
  }

  res.json(template);
});

module.exports = router;
