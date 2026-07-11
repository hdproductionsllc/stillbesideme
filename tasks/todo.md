# Still Beside Me – Build Progress

---

## Pass 12 — Mobile design-tool ergonomics (BUILT, approved 2026-07-10; not committed)

David: "did you check our design tool in mobile? can our user experience be improved?" I hadn't — prior pass verified print output, not live mobile. Read the customizer layout + touch code. Touch is well-wired (pan, pinch, divider-drag, iOS zoom guard, zoom-to-read). Four real, code-evident friction points. Fixing all four.

### Root causes
1. **Sticky preview eats the screen.** The *entire* `.preview-pane` is pinned on mobile (`customizer.css:1325`) — frame + zoom/swap + layout picker + panel toggle + style thumbs. ~450–500px tall; leaves a sliver for the form. In a portrait layout the stack exceeds viewport height and sticky silently breaks.
2. **Divider drag invisible on touch.** Handles only reveal on `:hover` (`customizer.css:178`); phones have no hover, so drag-to-resize is undiscoverable.
3. **Scroll fights photo-pan.** Preview sits at top; its canvas captures every touchmove with `preventDefault` (`customizer.js:570`), so a swipe-to-scroll that starts on the photo pans the photo instead of scrolling the page.
4. **Hint copy is desktop-only.** "Scroll to zoom" (`customizer.js:442`) — no scroll-to-zoom on a phone; it's pinch.

### Fix plan
- [x] **#1 Compact sticky preview.** Wrapped `.frame-preview` + `.preview-controls` in a `.preview-stage` (customize.html). Mobile: pin only `.preview-stage` (sticky, top:64px); `.preview-pane` static so the layout/panel/style selectors scroll away. Desktop unchanged. Zoom mode neutralizes stage styling so the enlarged frame scrolls.
- [x] **#2 Discoverable dividers on touch.** `@media (hover: none)`: divider line at 0.4 opacity always + rounded center grip pill (customizer.css). No change for mouse users.
- [x] **#3 Directional-intent gesture lock.** First-move intent in the canvas touchmove (customizer.js): <8px = undecided; then vertical-dominant → scroll (no preventDefault), horizontal-dominant / zoom>1 / fullscreen-zoom → pan; two fingers → pinch. saveState only on pan/pinch.
- [x] **#4 Device-aware hint copy.** `matchMedia('(pointer: coarse)')` → "Drag to reposition. Pinch to zoom." on touch; scroll wording on desktop.

### Verify
- [x] `node --check` customizer.js + preview.js → OK.
- [x] CSS brace balance 233/233; HTML wrap confirmed in source + served output.
- [x] Booted server, `/customize`, `/css/customizer.css`, `/js/customizer.js` all HTTP 200; `preview-stage` present in served HTML.
- [x] Grep confirmed no JS relied on old direct-child DOM (all id-based; `closest('.preview-pane')` still resolves).
- [ ] **David's device-mode walkthrough** (below) — the real visual/gesture confirmation; no headless browser in deps.
- [ ] Optional: throwaway Playwright screenshots if David wants hard before/after proof.

### 2-minute mobile check for David (Chrome DevTools)
1. `npm start`, open `http://localhost:3001/customize`, press **F12**, click the **device toolbar** icon (Ctrl+Shift+M), pick **iPhone SE**.
2. Upload a photo → the frame pins at the top; scroll down → the layout/style pickers slide away and the **form is fully reachable** under a compact pinned frame.
3. Switch to a **vertical/portrait layout** → frame still behaves (no viewport overflow / sticky break).
4. Swipe **up/down starting on the photo** → the **page scrolls** (doesn't hijack). Swipe **left/right on the photo** → it **pans**. Two-finger **pinch** → zooms.
5. On a 2-panel layout, look at the seam between photo & tribute → a **faint gold grip** shows; drag it to resize.
6. The hint under the photo reads **"Drag to reposition. Pinch to zoom."**

### Notes
- Minimal, surgical: DOM wrap preserves every `id` (JS lookups untouched); CSS changes gated behind mobile / `hover:none` media queries so desktop is byte-for-byte unchanged.
- Update `tasks/lessons.md` with the "verify live mobile, not just print output" lesson.

---

## Pass 11 — Low-price product line: Digital Keepsake $19.95 + Print-only 11×14 $39 (2026-07-07)

Executing the real `fable_to_opus` handoff (written 07:11, after Pass 10 started). David: "deploy agents to elegantly execute all phases." Built by workflow `wf_79a0b239-8a5` — 5 sequential Phase 1 stages (shared payment files, no parallel), Phase 2, then 2 parallel adversarial verifiers. Main-session review + re-verify before reporting done. **Not committed/deployed — David's trigger.** Phase 3 stays gated (David + 50 orders).

Locked assumptions (David can override): digital price $19.95; surfacing = grid rung + exit-intent + poem-generator CTA; no real charges or real Luma order placed.

### Phase 1 — Digital Keepsake $19.95 ✓ BUILT
- [x] `digital-11x14` SKU (fulfillment: digital) appended LAST in pet-tribute.json printProducts
- [x] checkout.js: digital SKU skips `shipping_address_collection`; price still server-side
- [x] order-confirmed GA4 `item_name` derives from SKU (was hardcoded "Framed Pet Tribute (11x14)")
- [x] adminReview digital approve: no proof email → render via printRenderer → store on /data → status `delivered` → delivery email; idempotent (upgrade_credit_created event guards coupon)
- [x] Stripe upgrade credit: coupon $19.95 off + promo `UPGRADE-<shortId>`, 30-day, single-use
- [x] `GET /download/:token` (proof_token pattern), 90-day graceful 404; download link on order-status
- [x] orderStatus digital timeline (confirmed → reviewed → delivered)
- [x] Secondary quiet digital CTA on the poem-generator page; customizer exit-intent flagged for designer lane

### Phase 2 — Print-only 11×14 $39 ✓ BUILT
- [x] `print-11x14` SKU ($3900) between framed-20x30 and digital in the array
- [x] lumaOrderApi: `print-` prefix → subcategory 103001, bleed option only (no frame-only shared options)
- [x] Flows through unchanged physical proof path; real Luma test order = David's trigger (NOT placed)

### Verify (adversarial, via agents + main-session review) ✓ DONE
- [x] Runtime verifier PASSED: node --check all touched JS; boots; framed + Pass 10 routes 200; lowPrice still 79; no cheap price in hero/schema
- [x] Skeptic verifier caught 1 HIGH + 2 LOW bugs (see fixes below)
- [x] Main-session re-verify: confirmed bugs in real code, applied fixes, re-derived + booted

### Bug fixes applied by main session (post-workflow)
- [x] **HIGH — checkout.js overcharge**: frame upcharge was added to ALL SKUs; a customer with a $60 signature frame selected who switched to digital/print-only was charged $79.95/$99 for a frame they never get. Fixed: frame upcharge gated on `sku.startsWith('framed-')`. Re-derived: framed unchanged $179, print-only $99→$39, digital $79.95→$19.95.
- [x] **LOW — stripeWebhooks.js**: idempotency guard omitted `delivered`/`cancelled`; a duplicate webhook post-delivery could reset a digital order and regenerate proof_token, breaking the emailed download link. Fixed: both terminal states added to the guard.
- [ ] **LOW residual (accepted)**: `ensureUpgradeCredit` not idempotent across a crash between `promotionCodes.create` and the event insert (sub-ms window, non-fatal — delivery still succeeds, only the credit is affected). Documented, not fixed. → v2.

### Coordination items for the designer (Pass 8) lane — NOT edited here
- [ ] Size grid ignores `sublabel` and doesn't visually distinguish the digital/print rungs (customizer.js renders label+price only)
- [ ] Confirm preview.js `setFrameSize` parses `digital-`/`print-` SKU prefixes to 11×14 proportions
- [ ] Add the customizer exit-intent digital down-sell to customize.html

### Shipped 2026-07-07 — commit cf71314 pushed to master (Railway auto-deploys). Phase 3 stays gated (David + 50 orders).
- App code + web pages committed. Internal strategy/financial docs HELD BACK from the commit: the GitHub repo is PUBLIC, so the business plan, fable_to_opus (COGS/margins), 10x-action-plan, and spec were not pushed. Awaiting David's call: keep repo public (docs stay local) or make private (then commit docs).

---

## Pass 10 — SEO Phase 2 batch: free poem generator, rainbow-bridge page, gift-cluster de-cannibalization (2026-07-07)

The `fable_to_opus` handoff file was empty; executing the SEO Phase 2 build sequence from `tasks/10x-action-plan.md` instead (David chose "do all three"). Pure-additive builds first (1 & 2, low risk), then a check-in before restructuring the live money pages (3).

### Build 1 — Free Pet Memorial Poem Generator (`/pet-memorial-poem-generator`) — highest-leverage ✓ DONE
- [x] `public/pet-memorial-poem-generator.html` — cloned the sympathy-helper free-tool pattern (env.js/GA/pixel head, WebApplication + FAQPage + BreadcrumbList schema, hero, tool form, poem result + copy, strong CTA to `/customize/pet-tribute`, FAQ, trust badges, footer, popup)
- [x] Form fields: pet name, type, personality, favorite memory, favorite thing, poem/letter toggle → POST `/api/poems/generate`
- [x] `public/js/poem-generator.js` — mirrors `sympathy.js`: submit → fetch → render `data.poem` → copy button + copy-on-CTA; handles 429; GA `poem_generated` event
- [x] `public/css/store.css` — added poem-result + format-toggle styles (design-token consistent)
- [x] `server.js` — clean-URL route + sitemap entry (priority 0.8, monthly)
- [x] Interlink: generator linked from `blog/pet-memorial-poems` + the rainbow-bridge page; footer Resources column updated
- [x] Honest CTA fix: removed unverifiable "carries over automatically" claim (don't own customizer.js); copy poem to clipboard on CTA click so "paste it in" is true

### Build 2 — Rainbow Bridge poem page (`/rainbow-bridge-poem-for-dogs`) — fixes live 404 ✓ DONE
- [x] `public/rainbow-bridge-poem-for-dogs.html` — full poem, accurate origin story (1959 Edna Clyne-Rekhy authorship revealed 2023 + 1980s wide circulation, hedged honestly), printable block with `window.print()` + `@media print`, CTA to product + poem generator; Article + FAQPage + BreadcrumbList schema
- [x] Slug is `rainbow-bridge-poem-for-dogs` (exact target of the former 404 link in `blog/pet-memorial-poems.html`)
- [x] `server.js` — clean-URL route + sitemap entry
- [x] Reconciled the stale authorship sentence in `blog/pet-memorial-poems.html` so the two pages agree

### Build 3 — De-cannibalize the gift cluster (⏸ DEFERRED — superseded by the real Fable handoff below; touches live money pages)
- [ ] Reshape `pet-memorial-gifts.html` into a numbered gift-guide listicle (format that ranks for gifter queries)
- [ ] Retarget `memorial-gifts.html` toward "pet memorial frame" (weakest SERP, exact product match)
- [ ] Preserve all existing pet-loss SEO, schema, pricing, CTAs

### Verify
- [x] `node --check` on server.js + poem-generator.js pass; all 6 JSON-LD blocks on new pages parse
- [x] Booted server on port 3999: new routes 200, old routes 200, sitemap includes both new URLs, former 404 link now resolves 200
- [x] Poem API end-to-end returned a REAL Fable 5 poem (live key), weaving in the specific details — full product experience proven
- [ ] Visual/pixel check deferred: no Puppeteer installed; pages reuse in-production CSS + a small set of new classes. Low risk, not eyeballed.

---

## Pass 9 — CEO conversion P0: measurable ads + trustworthy site (2026-07-06 late night, this session)

Six-agent audit (funnel, persuasion/trust, ops/economics, competitors/ad-costs, SEO, live mobile UX). Funnel mechanics are good (one page, no account, 3 required inputs, Stripe-hosted checkout). The dead-in-the-water items before ad spend:

1. **Conversion tracking is DEAD**: GA4 `purchase` never fires (`store.js` not loaded on `/order-confirmed`, and it sends no value anyway); Meta Pixel never initializes (`META_PIXEL_ID` never defined on any page); no Google Ads tag. Ad money would be unmeasurable.
2. **Zero real product photos** — every "frame" is a CSS mockup + stock pets (only David can fix: photograph the dress-rehearsal print).
3. **Testimonials look fabricated** (reused, unverifiable) — Meta ad-account-ban + FTC risk.
4. **Broken/detour CTAs**: sympathy-gifts hero/nav → dead `#collections` anchor; all blog CTAs → `/#collections` detour.
5. **Orphan human-memorial `.html` variants still served** (clean URLs 302 but `/loss-of-mother-gift.html` etc. bypass), contradicting pets-only + wrong price ($84.95).
6. **Silent ops stalls**: no admin alert on proof-gen/print/submit failures, no retry endpoint; webhook default provider `whcc` (broken creds) vs proofApproval `luma`; stale "UV-printed" poem system prompt.

NOTE: concurrent session owns customizer.js / preview.js / checkout.js / lumaOrderApi.js (frame-choice work below) — this pass does not touch them. Customizer pre-checkout validation (photo/name checked only server-side after Purchase click) deferred to that lane.

- [x] A. Landing pages: honest "Our promise to you" trust section replaces fabricated testimonials on 6 pages; .hero-eyebrow added to store.css + emotional eyebrows on pet/dog/cat; sympathy CTAs → /customize/pet-tribute
- [x] B. Blog: all 16 /#collections CTAs fixed across 8 posts (pet → customizer, 2 human-generic → /)
- [x] C. Backend: /js/env.js route; .html-variant redirects verified already covered; webhook provider default whcc→luma + warn; sendAdminAlert wired to proof-gen/print/submit failures; fulfillmentSubmitter.js shared module + POST /api/admin/order/:token/resubmit + admin button; poem prompt UV fix
- [x] E. Tracking: 24 pages on window.SBM_ENV gate via /js/env.js; real GA4 purchase (transaction_id + totalCents/100 + localStorage dedup) on order-confirmed; fbq Purchase + Google Ads conversion when configured; dead store.js purchase block removed
- [x] Adversarial verify (2 verifiers, passed, minor-only findings) + integration boot test (8/8 checks) — workflow wf_a1e90635-41e, 7 agents
- [x] Cleanup from verifier flags: "enhanced" photo claims removed (index, pet page); partner email "UV print" → archival print; human blog inline link off pet customizer
- [ ] HANDOFF to designer session (owns customizer files): customize.html still has dead `typeof META_PIXEL_ID` gate — needs same env.js two-line change; mobile sticky preview eats 46-61% viewport and covers form fields (P1 from live UX audit); "Banjo" placeholder shows a stranger's name before typing (P1); zoom-to-read opens on photo panel not poem (P2); begin_checkout hardcoded 119.00
- [ ] DAVID: real product photos; META_PIXEL_ID on Railway; verify Railway SMTP + FULFILLMENT_PROVIDER=luma; dress-rehearsal order
- Minor accepted: private-mode localStorage dedup edge; resubmit concurrency guard; lumaOrderApi duplicate pending-row quirk (forbidden file this pass)

---

## Pass 8 — Drop color-matching, add frame choice + upsells, poem position, restore title (2026-07-06 late)

David's direction: color-matching "doesn't work" — remove from copy AND product. New story: beautifully presented hero photo + poem + name/years, in a frame the customer chooses. Add frame selection + upgrades at 100% markup on real Luma option cost. Poem repositionable (up/down/left/right). Restore the pet name + dates title lost when UV was tried.

Frame menu (real Luma API pricing — color is FREE to us, width ~$1 diff):
- Included free: Black (default), White, Oak, Natural Wood.
- Standard profile: thin 0.875" (David wants thin; also ~$1 cheaper than 1.25").
- 100%-markup upsells: Gallery 1.25" width; premium decorative frames (Gold/Espresso/Matte-Black-wide); premium paper (Somerset Velvet / Cold Press vs archival matte). Exact upcharges pulled at checkout-wiring time.

- [x] Color-matching removal workflow (3 editors + verifier), keeps all pet-loss SEO work
- [x] Restore name+dates title: muted sample title in designer empty state; fixed print em-dash; node-verified buildTributeSvg emits name + en-dashed dates
- [ ] Reconcile + deploy safe batch (copy removal + title + earlier frame-scale/zoom/black-frame/paper), verify prod
- [ ] Frame selector (color + width) in designer with live preview
- [ ] Poem position control (left/right/above/below photo)
- [ ] Wire frame + upsells into checkout at 100% markup; lumaOrderApi resolves chosen subcategory + options
- [ ] Retire the auto-tint swatch feature (color-matching gone)
- [ ] STILL NEXT: David's dress-rehearsal order once designer is stable

---

## Pass 7 — Tribute text: smart, beautiful, guaranteed-to-fit (2026-07-06)

Owner report: generated poems/letters break ugly (a sentence ends with one lone word on its own line); portrait orientation cuts text off; the system must be reliable and elegant. Plus a false marketing claim to remove ("Professional photo enhancement / color-correct / upscale").

Root cause: TWO renderers that disagree.
- `public/js/preview.js` (live canvas): greedy wrap → orphans; font shrinks only to 82% then **overflows** (visual cut-off).
- `src/services/tributeRenderer.js` (real proof + print SVG): greedy wrap → orphans; **drops poem lines** (`break`) when out of vertical room → printed tribute truncated; never shrinks font.
So preview ≠ print, and portrait clips on the actual product.

- [x] A. Balanced, orphan-free wrapping — identical greedyPack/balanceLine in both renderers (preview.js canvas + tributeRenderer.js SVG). Over-wide author line → binary-searched balanced break (like CSS text-wrap: balance); no lone-word lines.
- [x] B. Guaranteed fit — never truncate, never overflow.
  - preview.js: poem font shrinks to a 60% legible floor so it always fits the panel (was: stopped at 82% then spilled past footer).
  - tributeRenderer.js: poem font fit to available height BEFORE drawing; deleted the line-dropping `break`; every line drawn.
- [x] C. Honest photo copy — enhancement/upscale/"professional photographer" claims replaced with "a real person reviews your photo/proof before printing" across index, pet/dog/cat-memorial (visible + JSON-LD FAQ) and customizer.js quality messages + assurance line.
- [x] D. Verify — node harness PASSED: no orphans, no truncation in portrait-short/tall + landscape + tiny proof, preview==print balancing. Rendered PNGs eyeballed (portrait-short fits full 8-line letter + family block; last wrap is two balanced halves). JSON-LD all parses; JS all `--check` clean.

Note: balancing does NOT add lines (greedy already yields min line count), so it never worsens vertical fit.

### v2 ideas
- Print path measures width in characters (innerW/(fontSize*0.5)); for perfectly tight fits, swap to real glyph metrics (opentype.js) so Georgia advance widths are exact.
- Preview floor is 60% (legibility); could match print's guaranteed-fit by drawing all lines regardless and only capping the font, since preview panels are rarely that cramped.
- Consider a subtle min-lines guard so a 2-word poem never balances oddly (not observed, but cheap insurance).

---

## Pass 6 — Sitewide truth pass, LFH off sale, SEO P1 (2026-07-06 night, workflow-assisted)

David's rulings: no 3D-print/UV/handcrafted claims anywhere; never say "mat" in copy (printed into artwork – sell the design); never pair $79 with 11×14; LFH removed for now (reversible); paper decision pending (semi-gloss vs archival matte – ships semi-gloss until he rules).

- [x] 7-agent workflow: 5 file-partitioned editors + adversarial verifier + SEO/AIO auditor
- [x] Truth pass across homepage, pet/dog/cat, sympathy/memorial, blog, customizer.js, template JSON
- [x] Mat-sweep correction pass (rule arrived mid-workflow): zero "mat" on live pages
- [x] LFH off sale: hidden template, 302s for 13 pages, links/schema/footers stripped (utility pages too)
- [x] FAQ consistency verified: schema == visible on all pages (17 checker flags all confirmed false positives)
- [x] SEO P1: fixed /loss-of-dog + /loss-of-cat 404 links, Product schema image on 6 pages, homepage Product url, keyworded H1 + definitional FAQ
- [ ] SEO P2 queue: retarget sympathy-gifts to "pet loss gifts"; retarget memorial-gifts + 2 human blogs; llms.txt; testimonial authenticity before ads; differentiate FAQ sets per page
- [ ] SEO P3 queue: sitemap real lastmod + drop noindexed URLs; 302→301 if LFH stays off >few weeks; comparison table in best-memorial-gifts blog; header nav category links + visible breadcrumbs
- [ ] STILL NEXT: David's dress-rehearsal order (11×14 + BANJO100), watch Luma submission live

---

## Pass 5 — Pet tribute size ladder + real Luma COGS pricing (2026-07-06 night)

David's pricing call (grounded in real Luma API costs, memory: `luma-cogs-2026-07.md`):
8×10 $79 / 11×14 $119 (default, Most Popular) / 16×20 $169 / 20×30 $249. LFH untouched.
Margins after Stripe: 48% / 62% / 66% / 68%. Landed COGS: $36 / $42 / $52 / $71.

- [x] pet-tribute.json: 4-rung printProducts ladder (customizer size grid renders automatically for multi-product templates)
- [x] Public pages: all `$97` copy → `From $79` (index, pet/dog/cat-memorial, sympathy-gifts, 3 blog posts)
- [x] JSON-LD: pet Product Offer → AggregateOffer $79–$249 (5 pages); dropped "11×14" from schema name
- [x] store.js: GA4 begin_checkout value 97 → 119 (default rung)
- [x] Verified: checkout prices by SKU server-side; printRenderer + lumaOrderApi parse size from SKU generically; no hardcoded 9700/SKU in backend

### Pre-flight for live self-test order (BANJO100 dress rehearsal)
- [x] Railway `FULFILLMENT_PROVIDER=luma` + production Luma creds confirmed
- [x] BANJO100 live in Stripe: 100% off, 0/5 redeemed, active
- [x] $0-checkout safe: webhook stores `payment_intent` but never requires it
- [x] Deployed + verified live (prod API serves 79/119/169/249 ladder)
- [x] Fixed phantom "Deployment crashed" emails (npm start SIGTERM → non-zero exit; railway.toml deleted, graceful shutdown added, healthcheck 120s; verified clean teardown + no email)
- [ ] NEXT: David places test order (11×14 + BANJO100); watch Luma submission in prod logs
- [ ] BEFORE ADS: copy audit — "3D-printed in their colors / name on frame" claims are stale sitewide (product is now Luma framed print, elegant dark frame)

---

## Pass 4 — Disable text-on-frame, revert to elegant classic dark frame (2026-07-06 eve)

Decision memory: `uv-frame-text-disabled-2026-07.md`. David: no text printed on the frame itself; elegant classic dark frame every order; mat/bevel still color-matched in the print; name/dates/poem stay in the tribute panel. Keep review gate. Keep UV code dormant for revival.

### Backend — remove UV inscription surfaces ✓ DONE
- [x] proofApproval.js: dropped generateUvFile + uv_file_url + uv fields in partner email
- [x] emailService.js: removed "On the frame:" (proof), frame line (review email), UV section + attachment (partner email)
- [x] adminReview.js: dropped frameText from response
- [x] adminOrder.js: dropped uvFileUrl; admin-order.html: dropped UV download button
- [x] admin-review.html: dropped "Frame will read" block
- [x] uvFrameRenderer.js + uv-frame-spec.json: left on disk, un-imported (dormant, revivable)

### Client — elegant classic dark frame, name/dates in panel ✓ DONE
- [x] preview.js setColors: fixed dark wood frame (#2a1e14), no engraving, nameOnFrame stays false; removeFrameText() clears stale rails
- [x] preview.js: dates/name/poem all render in panel; sample poem no longer gated on nameOnFrame
- [x] customizer.js: removed obsolete frame-icon (paw/heart) picker + Frame/Engraving color overrides (kept photo-match swatches → printed mat)
- [x] customizer.css: mat-board margin all sides (top/bottom molding restored after removing text rails)
- [x] Mobile: preview pane floats (sticky below 64px header) + frame fully visible/centered; thinner molding so it fits

### Verify ✓ DONE
- [x] Customizer preview screenshot: elegant dark frame, NO text on frame, Banjo+2014-2026+nickname+poem in panel (desktop 1200 + mobile 390)
- [x] Mobile float confirmed: frame stays pinned below header while form scrolls; measured boxes (frame fully within pane)
- [x] Backend modules load; full e2e (webhook→review→approve→customer approve→partner email, no UV) ALL CHECKS PASSED

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

### Shipped to production 2026-07-06 (commit 6cbbeff)
- [x] `ADMIN_EMAIL` set on Railway (david.stillbesideme@gmail.com)
- [x] Stripe webhook fixed: endpoint rotated, secret set properly on Railway (old var had a leading space in the NAME — broke every Nixpacks build), signed probe returns 200 from production
- [x] Persistent volume mounted at /data — before this, prod DB/uploads were wiped on every deploy
- [x] FULFILLMENT_PROVIDER=partner + PARTNER_PRINT_EMAIL set on Railway
- [x] Migration 007 applied in production

### David to do before first real order
- [ ] **SMTP on Railway (LAUNCH BLOCKER)** — no SMTP_HOST set, so order confirmations, review requests, and proof emails only print to server logs. Follow `tasks/resend-setup.md`, then set SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/EMAIL_FROM on Railway
- [ ] Tune `src/data/uv-frame-spec.json` (canvas size, font size, color) to the real E1 jig, print one test frame
- [ ] Add Rebecca to ADMIN_EMAIL when she's ready (comma-separated)

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
