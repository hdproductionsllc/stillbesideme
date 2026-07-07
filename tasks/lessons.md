# Lessons Learned

## Typography Rules
- **NEVER use em dashes (`—` / `\u2014`) anywhere.** Not in copy, not in code comments, not in titles, nowhere. Use en dashes (`–` / `\u2013`) for date ranges, attributions, and parenthetical breaks. The owner has explicitly banned em dashes across the entire project.

## Poem Content Rules
- NEVER generate poems that mention death, dying, the devil, hell, darkness, morbid imagery, or anything unsettling.
- Poems must be warm, hopeful, and life-affirming. Focus on what the pet brought to the family, not on the absence.
- No clichés like "rainbow bridge" or "angel wings" unless the owner specifically referenced them.
- These rules apply to both AI-generated poems and the fallback template stub.

## Canvas Rendering
- When rendering text on canvas, try all spacing compression tiers BEFORE shrinking font size. Poem font only shrinks as a last resort (legible floor ~60%). **Fit is guaranteed — a tribute is NEVER clipped.** In portrait/short panels the poem shrinks to fit rather than spilling past the footer.
- **There are TWO tribute renderers that MUST behave identically**: `public/js/preview.js` (canvas, what the customer sees) and `src/services/tributeRenderer.js` (SVG, the real proof + print). A fix to one is a bug in the other until both change. They share a mirrored greedyPack/balanceLine wrap and a fit-to-height pass.
- **Never truncate poem lines to save space.** The print SVG used to `break` out of the draw loop when it ran out of vertical room, silently dropping the end of longer letters in portrait. Fit the font to the space first, then draw every line.
- **Balanced wrapping, never greedy.** Poems/letters arrive with the author's own line breaks; only re-wrap an authored line when it's wider than the panel, and split it into balanced halves (binary-search the smallest width that holds the min line count) so no line is left a lone orphan word. Balancing keeps the min line count, so it costs no vertical space.
- Blank lines in poems should render at 50% line height, not full height. They're breathing room, not wasted space.
- Use en dash (`\u2013`) for date ranges on tribute panels, curly quotes (`\u201C`/`\u201D`) for nicknames.
- **Scale text by BOTH width and height**: `Math.min(w / 400, h / 260)`. Never use width-only scaling (`w / 400`) because wide-but-short panels (stacked layout) blow up the text. Height cap prevents overflow.

## Frame Preview Rendering
- **Single mat-opening bevel** on `.preview-panels::before` (not per-panel). Real WHCC mats have one opening; the composite print shows through it. Never add bevels to individual `.panel-photo` elements.
- **Frame size updates preview**: When the user selects a product size (e.g., 5x7, 11x14), the preview aspect ratio MUST update to match the real frame proportions. Landscape layouts use the wider dimension as width.
- **Panel gap = separator line**: Set `.preview-panels` background per theme to a shade slightly different from the tribute background, so the CSS Grid gap reads as an intentional divider. Must be visible in ALL themes, not just classic dark.

## Pricing & Margins
- **WHCC doesn't expose wholesale pricing via API.** Pricing is on their website: whcc.com → Products → Wall Art → Framing → Framed Prints → Pricing tab.
- **Always calculate WHCC cost as: frame + mat + acrylic.** The frame price includes a lustre print, but mat and acrylic are add-ons. Mat costs scale dramatically ($3.50 at 5x7, $92 at 30x40).
- **Target 40% gross margin minimum** on every SKU. Calculate: retail price = WHCC cost / 0.60, rounded to .95. After Stripe fees (2.9% + $0.30), effective margin is ~37%.
- **Don't claim "real wood" unless using Woodland line.** Lexington and most other WHCC mouldings are composite/MDF. Say "handcrafted frame" or "museum-quality frame" instead.
- **Removed non-standard WHCC sizes** (12x16, 18x24) and redundant sizes (8x8, 8x12, 10x10, 12x18, 16x24, 24x36). Final lineup: 5x7, 8x10, 11x14, 16x20, 20x24, 20x30, 30x40.
- **Current frame config:** Lexington Black (attr 602), Double White Mat (560, 615, 2495), Standard Acrylic (1878), Lustre Print (617), Wire Hanger (1907).

## Product Context
- PRIMARY buyer is sympathy gifter, SECONDARY is pet owner memorializing their own pet.
- Form questions must accommodate gift buyers who may not know personal details. Sublabels should explicitly say "skip this" for optional emotional fields in gift mode.

## API Integration
- **Always read the actual API docs before coding auth.** Don't assume header-based auth. WHCC uses query parameters (`grant_type=consumer_credentials&consumer_key=X&consumer_secret=X`) not headers. Cost us an entire debug cycle.
- **Test credentials immediately** after writing the auth code. Don't assume they're invalid just because the first attempt fails; the auth method might be wrong.
- **Inspect real API responses** before writing parsers. WHCC catalog is nested (`Categories[].ProductList[]`), not a flat array. Attribute fields use `Id`/`AttributeName`, not `AttributeUID`/`Name`.

## Stripe Setup (Still Beside Me)
To go live with payments, 3 things need to be configured:

1. **API Keys** - Stripe Dashboard → Developers → API Keys
   - Copy the **Secret key** (`sk_test_...` for test, `sk_live_...` for production)
   - Publishable key is `pk_test_...` / `pk_live_...` (not currently used since we redirect to Stripe hosted checkout)

2. **Webhook Endpoint** - Stripe Dashboard → Developers → Webhooks → Add endpoint
   - URL: `https://www.stillbesideme.com/api/stripe-webhooks`
   - Events to subscribe to: `checkout.session.completed`, `checkout.session.expired`
   - After creating, copy the **Signing secret** (`whsec_...`)

3. **Railway Environment Variables** - Railway Dashboard → your service → Variables
   - `STRIPE_SECRET_KEY` = secret key from step 1
   - `STRIPE_WEBHOOK_SECRET` = signing secret from step 2

**Flow**: Customer clicks "Purchase" → `POST /api/checkout` creates order + Stripe Session → redirect to Stripe hosted page → customer pays → Stripe webhook fires `checkout.session.completed` → our handler (`src/routes/stripeWebhooks.js`) confirms payment, saves shipping address, calls `whccOrderApi.placeOrder()` → WHCC prints and ships.

**Key files**: `src/routes/checkout.js`, `src/routes/stripeWebhooks.js`, `public/order-confirmed.html`

**Testing**: Use Stripe test mode with card `4242 4242 4242 4242`, any future expiry, any CVC. For local webhook testing: `stripe listen --forward-to localhost:3001/api/stripe-webhooks`

## Luma Prints Integration
- **Auth is HTTP Basic** (base64-encode `key:secret`), not OAuth tokens like WHCC. Much simpler.
- **Sandbox URL**: `https://us.api-sandbox.lumaprints.com`, **Production**: `https://us.api.lumaprints.com`
- **Product discovery workflow**: `GET /api/v1/stores` -> `GET /api/v1/products/categories` -> `GET /api/v1/products/subcategories/{id}/options`. Run `GET /api/luma/setup` to see everything at once.
- **Option IDs must be discovered first** via the setup endpoint, then hardcoded in `LUMA_CONFIG` inside `src/services/lumaOrderApi.js`. They won't change unless Luma updates their catalog.
- **LUMA_STORE_ID** must be set in `.env` after running the setup endpoint. Without it, `placeOrder()` will throw.
- **Fulfillment dispatch** is controlled by `FULFILLMENT_PROVIDER` env var (`luma` or `whcc`). Change it to switch providers without code changes.
- **Webhook is simpler than WHCC**: Luma fires a single `shipping` event with tracking info. No signature verification dance, no two-step register/verify flow.
- **Cost comparison**: Luma $33 for 11x14 framed vs WHCC $92. Same product specs (solid wood frame, white mat, acrylic, archival paper).

## Landing Page Framework (Oliver Kenyon CRO)
Every landing page should follow this structure in order:

1. **ATTENTION (Hero)** – Hook them immediately. Headline + subhead + hero visual + CTA. Answer "what is this and why should I care?"
2. **TRANSFORMATION** – Visual journey from NOT owning the product → owning and benefiting from it. Use icons, steps, and text to walk the buyer through: add to cart → receive → benefit. Show the before/after state.
3. **INTEREST Part 1: BENEFITS** – Exact outcomes the target buyer gets. Think time, money, freedom, emotion, lifestyle. Benefits sell. Lead with what the product DOES for them, not what it IS.
4. **INTEREST Part 2: FEATURES** – Only after they've visualized the outcome, show HOW you deliver it. Images, icons, text, video showing the bells and whistles. Features tell.
5. **DESIRE (Social Proof)** – Make them want it using other people. Reviews, testimonials, case studies, UGC. This is where FOMO lives.
6. **COMPARE** – Two options: (a) pitch against competitors, or (b) pitch against generalizations (broader market trends, general consumer expectations). Use comparison tables/cards.
7. **OBJECTIONS (FAQ)** – If they've scrolled this far they're interested but have questions. Use simple FAQ to address ordering, returns, outcomes, and "what if" concerns.
8. **FINAL CTA** – Close the sale with urgency and confidence.

## Product Claims Consistency (2026-07-06, David caught stale copy mid-checkout)
- When the product definition OR pricing changes, sweep ALL customer-facing surfaces in the SAME pass: meta tags, og/twitter tags, JSON-LD, page copy, alt text, JS-rendered strings, email templates. Never defer factual claims as "copy audit later" - a customer reads them today.
- **Price-size pairing rule**: never let a "From $X" price sit next to a specific size unless X is that size's price. "11x14 frame ... From $79" implies $79 buys an 11x14. Say "Four sizes from $79" or name the size WITH its own price.
- Proactively grep for claim drift after any product pivot; David should never find stale copy before we do.
- **Never claim capabilities the product doesn't have** (2026-07-06, David caught it). We do NOT color-correct, upscale, retouch, "enhance," or have a "professional photographer" touch photos. What actually happens: a real person reviews the photo + proof before printing and reaches out if it won't print well. Frame the review gate as the reassurance, never invent a magic-fix pipeline. This lived in customer copy AND JS-rendered strings (customizer.js quality messages + assurance line) — sweep both.
- **Never mention "mat" in customer-facing copy** (2026-07-06). The mat/bevel is printed into the artwork, not a physical mat. Naming it invites scrutiny and disappointment. Approved framing: "colors drawn from their photo", "their name and years set into the design", "archival, museum-quality print", "elegant dark wood frame". Sell the design, not the materials mechanics.
