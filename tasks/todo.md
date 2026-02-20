# Still Beside Me – Build Progress

## Phases 1-3: COMPLETE

### Phase 1: Foundation
- [x] package.json with all deps (sql.js, session-file-store, sharp, multer, heic-convert, uuid)
- [x] .env.example, .gitignore
- [x] Express server (port 3001) with sessions, static files, clean URLs
- [x] SQLite database with WAL mode and file-based migrations
- [x] Schema: customers, orders (with status CHECK), order_events + indexes
- [x] CSS design system (colors, fonts, spacing from spec Section 4)
- [x] Storefront HTML (hero, How It Works, template grid)
- [x] Customizer HTML (split-pane layout, canvas, form pane)
- [x] Mobile-first responsive layout

### Phase 2: Image Upload & Preview
- [x] Date-organized file storage (uploads/YYYY/MM/DD/{uuid}.ext)
- [x] Image processor: HEIC conversion, thumbnails (800px, JPEG 85%)
- [x] 4-tier quality assessment with warm messages (never rejects)
- [x] Entropy-based smart crop analysis (5x5 grid Shannon entropy)
- [x] POST /api/images/upload – full pipeline
- [x] POST /api/images/assess-quality – re-assess at different print size
- [x] POST /api/images/analyze-crop – re-analyze crop
- [x] Canvas-based preview renderer (print coordinates, retina-aware)
- [x] Drag-drop upload with instant local preview + background server upload
- [x] Quality badge + warm messaging UI

### Phase 3: Memory Collection & Live Preview
- [x] Poem library: 9 curated poems (Rainbow Bridge, If Tears, etc.)
- [x] 5 template JSON files (rainbow-bridge, forever-loved, custom-poem, together, paw-prints)
- [x] Template API: GET /api/templates (summaries), GET /api/templates/:id (full)
- [x] Poem API: GET /api/poems, GET /api/poems/:id, POST /api/poems/generate (stubbed)
- [x] Preview: text rendering with word-wrap, font loading, multi-line poems
- [x] Dynamic form generation from template memoryFields
- [x] Field types: text, textarea, select, poem-selector (tabbed widget)
- [x] Real-time preview binding (every keystroke → PreviewRenderer.setField())
- [x] Poem selector: library dropdown, AI stub tab, custom write tab
- [x] Product selector from template printProducts
- [x] Form state saved to sessionStorage (survives refresh)
- [x] Storefront template grid with metadata badges

### Phase 4: AI Poem Generator
- [x] Install @anthropic-ai/sdk + dotenv
- [x] Create poemGenerator.js service (Anthropic Claude API, spec prompt)
- [x] dotenv loading in server.js
- [x] Replace poem stub with real AI generation (graceful fallback if no key)
- [x] Rate limiting: 5 generations per session per hour
- [x] Poem caching in session history
- [x] Animated poem reveal (line-by-line with stagger delay)
- [x] Loading state with gentle dot-pulse animation
- [x] Rate limit error handling in UI
- [x] Regeneration (up to 3x), manual editing (carried over from Phase 3)

### Panel Resize, Third Panel & Quick Fixes
- [x] Bevel scope: ::before only on .panel-photo (customizer.css) and .mockup-photo (store.css)
- [x] Gift-mode sublabels: friendlier wording for sympathy gifters
- [x] Placeholder year: passDate placeholder "2024" → "2026"
- [x] CSS Grid conversion: .preview-panels from flexbox to CSS Grid with inline styles
- [x] Divider handle styles: .divider-handle col/row with gold hover line
- [x] Third panel CSS: .add-panel-btn, .layout-option-grid, .panel-panel2
- [x] preview.js refactor: dynamic panels Map, LAYOUTS data, buildPanels(), multi-panel render
- [x] preview.js API: setPhoto/setPhotoCrop/getPhotoCrop now accept panelId (backward compat)
- [x] preview.js custom ratios: getCurrentFrValues(), setCustomRatios(), resetCustomRatios()
- [x] customizer.js: PreviewRenderer.init('preview-panels', template) container-based init
- [x] customizer.js: attachDividerHandles() with drag-to-resize, MIN_FR=0.3, double-click reset
- [x] customizer.js: addThirdPanel() / removeThirdPanel() with layout mapping
- [x] customizer.js: rebuildLayoutSelector() – dynamic icons from LAYOUTS data
- [x] customizer.js: second photo upload zone for panel2
- [x] customizer.js: initPhotoCropInteraction(panelId) – per-panel crop
- [x] customizer.js: state persistence for thirdPanelEnabled, customRatios, per-panel crops
- [x] pet-tribute.json: grid-based layouts (columns, rows, areas, aspectRatio)
- [x] pet-tribute.json: 4 three-panel layout entries (hero-left, hero-top, photos-left, tribute-top)
- [x] pet-tribute.json: panel2 photo slot definition
- [x] customize.html: panels built dynamically (removed static panel divs)
- [x] customize.html: layout selector rebuilt dynamically + panel toggle placeholder

### Multi-Template Architecture & Human Memorial
- [x] preview.js: tributeMapping – reads name/nickname/familyPrefix from template instead of hardcoded pet fields
- [x] pet-tribute.json: added tributeMapping, poemLabel, giftLabels, formLabels blocks
- [x] templates.js: directory scan loads all .json files from src/data/templates/
- [x] server.js: parameterized /customize/:templateId route
- [x] letter-from-heaven.json: full human memorial template (11 fields, feedsPoem, no giftLabels)
- [x] poemGenerator.js: buildHumanPrompt() for first-person Letter From Heaven, dispatch by category
- [x] poemGenerator.js: generateHumanStub() template-based fallback letter
- [x] api.js: poem category filtering (?category= returns matching + universal)
- [x] api.js: pass-through body to poemGenerator.generate() (no longer destructures pet-specific fields)
- [x] customizer.js: URL-based template ID from /customize/:slug path
- [x] customizer.js: template-scoped session key (sbm-customizer-${TEMPLATE_ID})
- [x] customizer.js: conditional gift/self toggle (only when template.giftLabels exists)
- [x] customizer.js: template-driven form labels (poemSectionTitle, poemLibraryLink, poemLabel)
- [x] customizer.js: generic buildPoemBody() iterates feedsPoem fields + includes category
- [x] customizer.js: generate button says "Create [Name]'s Letter" or "Poem" based on template
- [x] customizer.js: name field listener reads from template.tributeMapping.name
- [x] customizer.js: dynamic page title from template.name
- [x] customizer.js: poem library filtered by template.category
- [x] customizer.js: updateFormLabelsForOrderType() reads from template.giftLabels
- [x] index.html: universal hero ("Keep them beside you, forever.")
- [x] index.html: collection cards (Pet Memorials + In Loving Memory) with frame mockups
- [x] index.html: updated testimonials (added human memorial review)
- [x] index.html: universal promise copy, updated founder story, universal footer
- [x] store.css: .collection-grid, .collection-card, .collection-card-mockup styles
- [x] store.css: responsive collection grid (stacks on mobile)

## Next

### Cart & Checkout
- [ ] Size/product selector with pricing
- [ ] Cart management (add, remove)
- [ ] Guest checkout (email + shipping)
- [ ] Stripe integration (requires keys)
- [ ] Order creation in database

### Proof & Fulfillment
- [ ] Server-side proof renderer
- [ ] Proof approval page
- [ ] Print-ready file generator (with bleed)
- [ ] Printful API integration

### Content & Polish
- [ ] Add curated human-specific poems to poems.js (Letter From Heaven, I'm Free, Miss Me But Let Me Go)
- [ ] Hero section with real photography
- [ ] Contact page with FAQ
- [ ] SEO basics

### Future Templates
- [ ] Fishing In Heaven
- [ ] First responder templates
