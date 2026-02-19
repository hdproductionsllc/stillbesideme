# Still Beside Me — Build Progress

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
- [x] POST /api/images/upload — full pipeline
- [x] POST /api/images/assess-quality — re-assess at different print size
- [x] POST /api/images/analyze-crop — re-analyze crop
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

## Next: Phase 5-8

### Phase 5: Cart & Checkout
- [ ] Size/product selector with pricing
- [ ] Cart management (add, remove)
- [ ] Guest checkout (email + shipping)
- [ ] Stripe integration (requires keys)
- [ ] Order creation in database

### Phase 6: Proof & Fulfillment
- [ ] Server-side proof renderer
- [ ] Proof approval page
- [ ] Print-ready file generator (with bleed)
- [ ] Printful API integration

### Phase 7: Storefront & Polish
- [ ] Hero section with real photography
- [ ] Collection browsing with filtering
- [ ] Social proof / testimonials
- [ ] Contact page with FAQ
- [ ] SEO basics

### Phase 8: Human & Niche Templates
- [ ] Letter From Heaven
- [ ] Fishing In Heaven
- [ ] First responder templates
