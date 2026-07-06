# Still Beside Me – Build Progress

---

## Pass 3 — Review Gate + Programmatic UV Name File (2026-07-06)

Plan: `C:\Users\david\.claude\plans\dreamy-singing-wilkes.md`

### Phase A — Review gate (brand rule: no proof email without human approval) ✓ DONE
- [x] A1. Migration 007: `awaiting_review` status + `reviewed_at`, `uv_file_url` columns (FK-safe recreate — PRAGMA foreign_keys OFF during rebuild since 3 child tables reference orders)
- [x] A2. stripeWebhooks.js: payment → `awaiting_review`, review-request email replaces auto proof email; `awaiting_review` added to webhook idempotency list (retry would have double-processed)
- [x] A3. emailService.js: `sendReviewRequest()` to ADMIN_EMAIL (comma-separated works natively in nodemailer)
- [x] A4. adminReview.js: GET data / POST poem (edit + regenerate) / POST approve (send proof); handles `change_requested` too — closes the previously dead-ended change-request loop
- [x] A5. public/admin-review.html + server.js wiring (`/admin/review/:token`)
- [x] A6. orderStatus.js: "Design in progress" label + hand-review timeline copy

### Phase B — UV frame name file (programmatic, never retyped) ✓ DONE
- [x] B1. uv-frame-spec.json: one font, one size, one placement — David tunes to E1 jig
- [x] B2. uvFrameRenderer.js: fields_json → PNG, auto-fit long names, returns null for non-pet orders
- [x] B3. Generated on customer proof approval; attached + linked in partner email, download button on admin order page
- [x] B4. Proof email shows "On the frame: {name} · {years}" — customer approval covers frame spelling

### Verification ✓ ALL PASSED (30/30 e2e checks)
- [x] Migration clean against copy of store.db — rows/events survive, FK check + integrity_check ok, bogus statuses still rejected
- [x] Signed Stripe webhook → `awaiting_review`; review email to david+rebecca; NO customer proof email; retry idempotent; customer proof page 410s pre-approval
- [x] Review page: edit poem → proof regenerated; approve → proof email sent, `proof_ready`, `reviewed_at` stamped; double-approve doesn't re-send
- [x] Customer approve → print JPEG + uv-frame PNG ("Banjo · 2014 - 2026", 3600×375, verified visually)
- [x] Change-request round trip: notes on review page → edit → re-approve → notes cleared
- [x] Review page screenshot-verified at 390px and 1200px (Puppeteer)

### David to do before this goes live
- [ ] Set `ADMIN_EMAIL` on Railway (comma-separated for you + Rebecca) — without it, paid orders wait in review with no notification
- [ ] Tune `src/data/uv-frame-spec.json` (canvas size, font size, color) to the real E1 jig, print one test frame

---

## Pass 2 — Pet Memorial Pivot: One Product, UV-Printed 11×14 (2026-06-11)

Plan: `C:\Users\david\.claude\plans\polished-bubbling-wilkinson.md`

### Phase A — Product simplification ✓ DONE
- [x] pet-tribute.json: single 11×14 SKU $159.95, 2-panel layouts only, classic-dark only, colorMode:auto, printSpec
- [x] customizer.js: static price line for single product, skip style picker on colorMode:auto, gate 3-panel UI, validate restored state
- [x] preview.js: intersect LAYOUTS with template layouts (activeLayouts)
- [x] Verify: template JSON parses; LFH unchanged (6 layouts / 3 styles / 7 products)

### Phase B — Auto-matched mat/bevel colors ✓ DONE
- [x] colorUtils.js (hex/HSL/mix/luminance/contrast)
- [x] imageProcessor.js: extractPalette (median-cut) + deriveAutoColors (muted bevel clamp); wired into upload
- [x] api.js: palette in upload response + session
- [x] tributeRenderer.js: resolveColors() + calculateMatLayout() + buildMatOverlaySvg() + renderPhotoCover()
- [x] printRenderer.js + proofGenerator.js: mat-aware branch on fields.colors
- [x] preview.js setColors() + ColorMath; customizer.css theme-auto + swatch row; customizer.js swatch UI
- [x] checkout.js: validate + store colors in fields_json
- [x] **BONUS BUG FIX**: smart-crop "50% 50%" positions crashed sharp in proof/print renderers — every order with a smart crop would have failed at proof generation. Fixed with manual cover-crop (renderPhotoCover)
- [x] buildTributeSvg: content now vertically centered (was top-anchored with dead space)
- [x] Verify: print 4200×3300 w/ 450px mat + bevel rings; proof + portrait + legacy regression all render

### Phase C — Partner UV fulfillment ✓ DONE
- [x] Migration 006: admin_token + tracking columns on orders (applied)
- [x] stripeWebhooks.js: generate admin_token alongside proof_token
- [x] proofApproval.js: partner branch → partner email w/ print file + admin link, in_production
- [x] emailService.js: sendPartnerOrderEmail (attachment <20MB + link) + sendShippedEmail
- [x] adminOrder.js + admin-order.html (mark shipped + tracking, idempotent, ?resend=1)
- [x] orderStatus.js: orders-level tracking first + partner_shipped timeline
- [x] .env: FULFILLMENT_PROVIDER=partner — **DAVID: set PARTNER_PRINT_EMAIL (and same vars on Railway)**
- [x] Verify: seeded order → admin GET → ship POST → customer email fired → status page shows shipped + tracking

### Phase D — Poem generator → Fable 5 ✓ DONE
- [x] poemGenerator.js: claude-fable-5 → sonnet-4-6 → stub chain, max_tokens 1024, elegist system prompt, refusal handling, favoriteThing bug fixed
- [x] Fixed: Fable 5 thinking block is content[0] — find text block instead
- [x] buildPetLetterPrompt + generatePetLetterStub ("A letter from them")
- [x] pet-tribute.json poemFormats + customizer format toggle (persisted)
- [x] Verify: LIVE — both formats generated on ai-fable-*; sonnet fallback exercised; quality excellent

### Phase E — Pet-first marketing ✓ DONE
- [x] index.html: pet hero ($159.95, direct CTA), single-Offer Product schema + free-shipping details, UV story + matched-colors showcase (replaces 3-styles), UV FAQ (schema + visible), LFH demoted to slim band, popup/footer/copy sweep, GA4 begin_checkout value → 159.95
- [x] pet/dog/cat pages: $159.95, 11×14, UV language, single-Offer schema — zero stale 84.95 left
- [x] Mixed pages (sympathy-gifts, memorial-gifts, blog): per-occurrence judgment — pet mentions updated, LFH/generic mentions kept truthful at $84.95
- [x] Human-memorial pages untouched (their pricing is still correct)
- [x] Verify: 14 key pages 200; all JSON-LD blocks parse; pet pages clean of old pricing

### Post-ship (David)
- [ ] Real product photos of UV frame
- [ ] Pinterest account + pins
- [ ] META_PIXEL_ID + Mailchimp keys in env
- [ ] Review-request email, welcome sequence, Google Ads

---

## Pass 1 — Final Launch Blockers (2026-05-20)

Most of the original launch-readiness items were already done. Real remaining gaps:

### 1. Upgrade poem model to Sonnet 4.6 ✓ DONE
- [x] `src/services/poemGenerator.js:11` — Sonnet 4.5 → Sonnet 4.6 (same price, better creative writing)
- [x] Added markdown-strip safety net (prompt instruction + post-process regex)
- [x] Verified with 4 real generations, all clean

### 2. Order status page ✓ DONE
- [x] `/order` lookup form + `/order/:token` direct deep link
- [x] `src/routes/orderStatus.js` — APIs: `GET /api/orders/status/:token`, `GET /api/orders/lookup`
- [x] `public/order-status.html` — page with order card + visual timeline
- [x] Email + 8-char shortId lookup (no login required)
- [x] Color-coded status badge (sage=shipped, amber=action-required, red=cancelled)
- [x] Tracking link surfaces when Luma webhook fires
- [x] Wired into `server.js` + sitemap
- [x] Linked from `order-confirmed.html` (post-Stripe redirect)
- [x] Verified visually with Puppeteer in 3 states (shipped / proof_ready / lookup form)

### 3. Transactional email plumbing ✓ DONE (code) — pending user setup
- [x] Added `sendOrderConfirmation()` — fires immediately on Stripe webhook (no more dead silence between payment and proof email)
- [x] All 3 customer emails now include link to `/order/:token`
- [x] `scripts/test-email.js` — script to verify SMTP wiring with one command
- [x] `tasks/resend-setup.md` — step-by-step setup checklist
- [ ] **USER: Resend signup + DNS records + Railway env vars** (see `tasks/resend-setup.md`)

### 4. End-to-end live test (blocked on email setup)
- [ ] Stripe test-mode buy → confirmation email → proof email → approve → Luma logs → status page reflects each step

---

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

### Launch Readiness (Complete)
- [x] GA4 real measurement ID (G-CM9DENCN96) on all pages
- [x] Security hardening: helmet, rate limiting, upload restriction
- [x] Legal pages: Privacy Policy, Terms, Refund Policy, Shipping Policy
- [x] Footer legal links + Contact link on all pages
- [x] Contact page with form + API endpoint
- [x] Sentry error monitoring (awaiting SENTRY_DSN)
- [x] Meta Pixel + Google Ads tag (placeholder IDs, ready to activate)
- [x] Trust badges on homepage + all landing pages
- [x] Email capture: exit-intent popup + footer signup form + Mailchimp API proxy
- [x] Mobile UX improvements for customizer touch interactions
- [x] GA4 e-commerce events (begin_checkout, purchase)

## Next

### Cart & Checkout
- [ ] Size/product selector with pricing
- [ ] Cart management (add, remove)
- [ ] Guest checkout (email + shipping)
- [ ] Stripe integration (requires keys)
- [ ] Order creation in database

### WHCC Print Lab Integration (standalone API clients)
- [x] Database migration: whcc_catalog, whcc_product_map, whcc_orders tables
- [x] Catalog service: 24hr cache, SKU mapping CRUD, auto-detect product matches
- [x] Order Submit API client: auth, catalog, import/submit, webhook registration
- [x] Editor API client: JWT auth, products, designs, editor sessions, orders
- [x] Webhook handler: HMAC-SHA256 verification, Processed/Shipped events
- [x] Admin routes: health, catalog search, product mapping, test orders
- [x] Editor routes: health, products, designs, sessions, export, orders
- [x] Routes mounted in server.js with raw body middleware for webhooks
- [ ] Get valid WHCC API credentials (current sandbox creds return 403)
- [ ] Fetch catalog and set up product mappings (framed-8x10, 11x14, 16x20, 20x24)
- [ ] Test sandbox order end-to-end
- [ ] Register webhook with public Railway URL
- [ ] Wire placeOrder() into checkout flow after payment

### Proof & Fulfillment
- [ ] Server-side proof renderer
- [ ] Proof approval page
- [ ] Print-ready file generator (with bleed)
- [ ] WHCC order submission after proof approval

### Content & Polish
- [ ] Add curated human-specific poems to poems.js (Letter From Heaven, I'm Free, Miss Me But Let Me Go)
- [ ] Hero section with real photography
- [ ] Contact page with FAQ
- [ ] SEO basics

### Future Templates
- [ ] Fishing In Heaven
- [ ] First responder templates
