# Lessons Learned

## Typography Rules
- **NEVER use em dashes (`—` / `\u2014`) anywhere.** Not in copy, not in code comments, not in titles, nowhere. Use en dashes (`–` / `\u2013`) for date ranges, attributions, and parenthetical breaks. The owner has explicitly banned em dashes across the entire project.

## Poem Content Rules
- NEVER generate poems that mention death, dying, the devil, hell, darkness, morbid imagery, or anything unsettling.
- Poems must be warm, hopeful, and life-affirming. Focus on what the pet brought to the family, not on the absence.
- No clichés like "rainbow bridge" or "angel wings" unless the owner specifically referenced them.
- These rules apply to both AI-generated poems and the fallback template stub.

## Canvas Rendering
- When rendering text on canvas, try all spacing compression tiers BEFORE shrinking font size. Poem font only shrinks as a last resort (floor 82%). Never cut off text with a hard `break`.
- Blank lines in poems should render at 50% line height, not full height. They're breathing room, not wasted space.
- Use en dash (`\u2013`) for date ranges on tribute panels, curly quotes (`\u201C`/`\u201D`) for nicknames.
- **Scale text by BOTH width and height**: `Math.min(w / 400, h / 260)`. Never use width-only scaling (`w / 400`) because wide-but-short panels (stacked layout) blow up the text. Height cap prevents overflow.

## Frame Preview Rendering
- **Single mat-opening bevel** on `.preview-panels::before` (not per-panel). Real WHCC mats have one opening; the composite print shows through it. Never add bevels to individual `.panel-photo` elements.
- **Frame size updates preview**: When the user selects a product size (e.g., 5x7, 11x14), the preview aspect ratio MUST update to match the real frame proportions. Landscape layouts use the wider dimension as width.
- **Panel gap = separator line**: Set `.preview-panels` background per theme to a shade slightly different from the tribute background, so the CSS Grid gap reads as an intentional divider. Must be visible in ALL themes, not just classic dark.

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
