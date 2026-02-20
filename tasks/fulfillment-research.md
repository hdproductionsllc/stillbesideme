# Print Fulfillment Research — Still Beside Me

**Date:** 2026-02-20
**Goal:** Find the best automated fulfillment path for custom framed memorial art.
**Ideal flow:** Customer approves proof on website -> order auto-submitted to lab via API -> lab prints, frames, ships directly to customer -> zero manual intervention after approval.

---

## Executive Summary

**Recommended approach: WHCC API as primary fulfillment.**

WHCC has a fully documented REST API at [developer.whcc.com](https://developer.whcc.com/) with endpoints to create, confirm, and track orders. Since the owner already has pro pricing at WHCC and they are the industry gold standard for quality, this is the clear winner. They support white-label drop shipping ($7.95/order) with no WHCC branding — the customer only sees your business name. Their API supports everything from simple prints to complex frames with multi-opening mats.

**Backup/future option:** Prodigi or Printful as secondary fulfillment for lower-cost product tiers or international orders.

---

## Option-by-Option Comparison

### 1. WHCC (White House Custom Colour) — RECOMMENDED

| Criteria | Details |
|---|---|
| **REST API** | Yes. RESTful endpoints to create, confirm, and track orders. Developer portal at [developer.whcc.com](https://developer.whcc.com/) |
| **Authentication** | OAuth-based (studio.whcc.com/oauth/) |
| **Framed Print Products** | Extensive. 14 moulding lines, 5x7" to 30x40", real wood and metal frames |
| **Frame Options** | Woodland (ash/walnut/gray), Gallery (black/white/natural/mocha), Academie (black/gold), Lexington (cherry/black/bronze/brown/iron), Distressed, Colonial, Hudson, Metal, Modern Metal, Patina, Versailles, Brimfield, Gramercy + more |
| **Mat Board** | White, Black, Gray. Single-opening and multi-opening layouts |
| **Acrylic Options** | Standard acrylic, Glare-resistant acrylic, No acrylic |
| **Paper/Print Surfaces** | Lustre (Fujicolor Crystal Archive), Deep Matte, Lustre w/ Protective Lamination, Fine Art papers (Smooth Matte, Aquarelle Rag, Photo Rag Baryta, Torchon, Photo Rag Metallic), Canvas, Metal |
| **Quality Tier** | Professional — industry gold standard. 100-year display longevity, 200-year dark storage. Fujicolor Crystal Archive archival paper |
| **Pricing (framed)** | Starts at $38.89 (smallest). Pro photographer wholesale pricing — not publicly listed, only visible in your account. Estimated: 8x10 framed ~$40-55, 16x20 framed ~$75-120 depending on moulding |
| **Drop Shipping** | Yes. $7.95/order to contiguous US. Expedited shipping available |
| **White Label** | Yes. No WHCC branding inside or outside the package. Your business name and return address on shipping label. No invoice included |
| **Premium Packaging** | $5.50 add-on for gift-ready unboxing experience (discounted for drop ship) |
| **Turnaround** | 3-5 days production |
| **Shipping** | Free ground shipping on standard orders. Expedited upgrades available |
| **Minimum Order** | $16.00 per product catalog category, waived for drop ship with lowest-cost shipping |
| **Existing Account** | YES — owner already has pro pricing |

**API Capabilities (from developer.whcc.com):**
- Order Submit API: create, confirm, track orders via REST
- Editor API: unbranded design experiences (could be useful for customer-facing proofing)
- Supports simple prints through complex frames with multi-opening mats
- JSON payloads with shipping address, order attributes (via AttributeUID), items, and image assets (URLs)
- GitHub org at github.com/whcc with examples and case studies

**Integration options:**
- Direct REST API (best for custom site like Still Beside Me)
- Shopify integration (if you ever add a Shopify storefront)
- Spark Shipping (middleware for WooCommerce, BigCommerce, Magento)
- NextGEN Pro / Imagely (WordPress plugin with auto-fulfillment)

**Why WHCC wins:**
1. You already have an account with pro pricing
2. Industry-best quality for memorial/sympathy products (this matters for your brand)
3. Full REST API that can be called from your Node.js server
4. White-label drop shipping with premium packaging option
5. The premium packaging ($5.50 extra) is perfect for a sympathy gift — beautiful unboxing
6. Archival quality (100-year display life) is a genuine selling point for memorial art

---

### 2. ACI (American Color Imaging)

| Criteria | Details |
|---|---|
| **REST API** | NO. No public API found |
| **Ordering Systems** | ROES (desktop Java app), ACI FLEX (proprietary desktop software), OrderPix Suite, ROES for Web |
| **Framed Print Products** | Yes — full matting and framing division |
| **Quality Tier** | Professional — comparable to WHCC |
| **Pricing** | Not publicly listed |
| **Drop Shipping** | Unknown — likely available but not documented publicly |
| **White Label** | Unknown |
| **Automation** | Not possible without GUI automation hacks |

**Verdict:** Not viable for automated fulfillment. No API means you cannot programmatically submit orders. Would require manual ordering through their desktop software, which defeats the purpose. Keep as manual backup for edge cases only.

---

### 3. Printful

| Criteria | Details |
|---|---|
| **REST API** | Yes. Full-featured REST/JSON API at [developers.printful.com](https://developers.printful.com/docs/) |
| **Authentication** | Private tokens with access scopes and expiration dates |
| **Framed Print Products** | Yes. Enhanced Matte Paper Framed Poster (no mat), Matte Paper Framed Poster With Mat, Premium Luster Photo Paper Framed Poster |
| **Frame Options** | Black, White, Red Oak (alder wood, 0.75" thick) |
| **Mat Board** | Yes — "Framed Poster With Mat" product has smooth white mat board |
| **Paper** | Enhanced Matte (10.3 mil, 189 g/m², Epson), Premium Luster Photo Paper |
| **Quality Tier** | Consumer-plus — "museum-quality" marketing but not on par with pro labs. Giclée inkjet on matte paper, NOT silver halide/Crystal Archive |
| **Pricing (base cost)** | 8x10 framed: ~$18.50, 12x16: ~$22-26, 16x20: ~$28-32 (estimates, exact pricing in dashboard). With mat: add ~$5-8 |
| **Shipping (US)** | $10.49 first item + $4.50 each additional |
| **Drop Shipping** | Yes — built-in, it is a POD service |
| **White Label** | Yes — your branding, custom packing slips, branded inserts on Growth plan |
| **Turnaround** | 2-5 business days |
| **Rate Limits** | 30 requests per 60 seconds (unauthenticated) |

**Key API endpoints:**
- `GET /products` — catalog with all variants and pricing
- `POST /orders` — create and submit orders
- `GET /orders/{id}` — track order status
- Webhooks for order status changes

**Pros:** Cheapest base cost, excellent API documentation, easy integration, no minimum orders, free to start.
**Cons:** Quality is noticeably below WHCC. Not real wood solid frames (alder semi-hardwood). Limited frame/mat options. No archival photographic paper (Crystal Archive). For a sympathy product at $100+ retail, customers may notice the quality gap.

---

### 4. Prodigi

| Criteria | Details |
|---|---|
| **REST API** | Yes. Full REST/JSON API v4.0 at [prodigi.com/print-api/docs/reference](https://www.prodigi.com/print-api/docs/reference/) |
| **Authentication** | API key via `X-API-Key` header |
| **Environments** | Sandbox: api.sandbox.prodigi.com, Production: api.prodigi.com |
| **Framed Print Products** | Yes. Classic Frames (solid wood, satin-laminated), Budget Framed Posters (MDF/plastic), Aluminium Frames, Box Frames, Backloader Frames |
| **Frame Options** | Classic: Black, White, Natural, Antique Silver, Brown, Antique Gold, Dark Grey, Light Grey (8 colors) |
| **Mat Board** | Available on classic frames |
| **Paper** | Fine art giclée printing |
| **Glaze Options** | Perspex and moth-eye glaze (anti-reflective) |
| **Quality Tier** | Mid-to-high. Handmade by specialist picture framers. Better than Printful, below WHCC |
| **Pricing** | Not publicly listed — available in dashboard. Quote endpoint: `POST /v4.0/quotes` |
| **Drop Shipping** | Yes — built-in. 50+ print partners in 10+ countries |
| **White Label** | Yes — fully white-label packaging |
| **Turnaround** | Typically dispatched within 24-48 hours |
| **SKU format** | e.g., `GLOBAL-CFPM-16X20` for classic frame |

**Key API endpoints:**
- `POST /v4.0/Orders` — create and submit in single request
- `GET /v4.0/Orders` — list/filter orders
- `GET /v4.0/products/{sku}` — product details
- `POST /v4.0/quotes` — get pricing without creating order
- `GET /v4.0/Orders/{id}/actions` — available actions (cancel, update)
- Idempotency key support for duplicate prevention
- Postman collection available

**Pros:** Best API design of all options. Classic frames are real wood. Good international fulfillment network. Sandbox environment for testing. Quote endpoint for real-time pricing.
**Cons:** Pricing not transparent until you sign up. Quality is good but not pro lab grade. Fewer frame moulding options than WHCC.

---

### 5. Gooten

| Criteria | Details |
|---|---|
| **REST API** | Yes. Full REST/JSON API, free access, well-documented |
| **Framed Print Products** | Yes. Economy (MDF), Standard (MDF), Premium (real wood — Classic or Contemporary styles) |
| **Frame Options** | Premium: Black, White, Natural, Walnut, Cherry. Thickness: 1", 1.25", 1.5" |
| **Mat Board** | Yes on Premium — No Mat, 1.5", 2", 2.5" options |
| **Paper** | Premium: Epson Hot Press Bright White (330gsm), Hahnemuhle Photo Rag 308, Moab Entrada Bright Rag (290gsm), Moab Somerset Museum Rag (300gsm) — all 100% cotton, acid-free, archival |
| **Glass** | Shatter-proof UV-coated acrylic |
| **Quality Tier** | Premium tier is high quality — archival cotton papers, real wood frames, UV acrylic |
| **Pricing** | Not publicly listed. 8x10 framed was ~$19.90 base (older data). Shipping can be expensive |
| **Drop Shipping** | Yes — built-in |
| **White Label** | Available |
| **Sizes** | 8x8 through 24x36, including 8x10, 12x16, 16x20 |

**Key API features:**
- Price Estimate API
- Address Validation API
- Shipping Options API
- Shipping Price Estimate API
- No monthly fees, no transaction fees

**Pros:** Premium tier has genuinely good materials (Hahnemuhle, Moab papers). Real wood frames with mat board options. Free API with no paywall. Multiple paper options.
**Cons:** Shipping costs reported as high. Not a professional photography lab. Quality control can be inconsistent across their manufacturer network. Economy/Standard tiers are MDF (avoid for memorial products).

---

### 6. Frame It Easy — NOTABLE DISCOVERY

| Criteria | Details |
|---|---|
| **REST API** | Yes. Full REST API with [Postman documentation](https://documenter.getpostman.com/view/7462304/Tz5s3bQB) |
| **What They Do** | Custom framing + printing 3PL. US-based manufacturing. They print, frame, package, and ship |
| **Frame Options** | Any size from 5x5 to 42x62 in 1/16" increments. Multiple frame styles |
| **Mat Board** | Yes — custom matting |
| **Paper** | Museum-quality giclée on conservation-grade materials |
| **Quality Tier** | High — museum-grade framing, conservation materials |
| **Pricing** | 15% trade discount for resellers, no minimums |
| **Drop Shipping** | Yes — US only |
| **White Label** | Yes — full white-label branding |
| **Integrations** | Shopify app, direct API, or manual website orders |

**API workflow:**
1. Create user
2. Design picture frame (specify all options)
3. Save frame product
4. Create order with sold frame
5. Frame It Easy manufactures and ships

**Pros:** True custom framing (not POD poster frames). US manufacturing. Flexible sizing. Museum-grade materials. 15% trade discount.
**Cons:** Less known brand. US-only shipping. Would need to evaluate quality vs WHCC side-by-side.

---

### 7. ShipStation

| Criteria | Details |
|---|---|
| **What It Is** | Shipping management platform, NOT a print lab |
| **REST API** | Yes. Full shipping API with 200+ carrier integrations |
| **Relevance** | Only useful if managing fulfillment from multiple sources and need unified shipping/tracking |
| **Drop Shipping** | It manages shipping labels, not printing/framing |

**Verdict:** Not needed if using WHCC's built-in drop shipping. Could be useful later if managing orders across multiple labs. Not a priority.

---

### 8. ROES (Remote Order Entry System)

| Criteria | Details |
|---|---|
| **What It Is** | Java-based desktop ordering software used by many pro labs |
| **API/Automation** | NO public API. No scripting interface. GUI-only |
| **Automation Options** | ROES Events module for batch/volume CSV imports (sports/school photography), but not REST API |
| **Relevance** | ROES is what many labs (including ACI) use, but WHCC has their own API that bypasses ROES entirely |

**Verdict:** Not needed. WHCC's direct API is the better path. ROES is a legacy desktop tool not designed for web automation.

---

## Side-by-Side Comparison Matrix

| Feature | WHCC | ACI | Printful | Prodigi | Gooten | Frame It Easy |
|---|---|---|---|---|---|---|
| **REST API** | Yes | No | Yes | Yes | Yes | Yes |
| **Quality** | Pro (best) | Pro | Consumer+ | Mid-High | Mid-High* | High |
| **Real Wood Frames** | Yes (14 lines) | Yes | Semi (alder) | Yes (solid) | Yes (premium) | Yes |
| **Mat Board** | Yes (3 colors) | Yes | Yes (white only) | Yes | Yes (4 sizes) | Yes |
| **Archival Paper** | Yes (Crystal Archive, 100yr) | Yes | No | Giclée | Yes (cotton) | Yes (giclée) |
| **Drop Ship** | Yes ($7.95) | Unknown | Yes (built-in) | Yes (built-in) | Yes (built-in) | Yes (US only) |
| **White Label** | Yes | Unknown | Yes | Yes | Yes | Yes |
| **Premium Packaging** | Yes ($5.50) | Unknown | Growth plan | Unknown | Unknown | Unknown |
| **Est. Cost 8x10 framed** | ~$40-55 | N/A | ~$18-25 | Sign up | ~$20 | Sign up |
| **Est. Cost 16x20 framed** | ~$75-120 | N/A | ~$28-35 | Sign up | ~$30-40 | Sign up |
| **Existing Account** | YES | YES | No | No | No | No |
| **Best For** | Memorial/sympathy (quality matters) | Manual backup | Budget product line | International | Budget alt | Custom sizing |

*Gooten premium tier only; economy/standard are MDF

---

## Recommended Architecture

### Phase 1: WHCC API Integration (Primary)

```
Customer approves proof
    |
    v
Server generates print-ready file (with bleed)
    |
    v
POST to WHCC Order Submit API
  - Upload image asset (URL or upload)
  - Specify product (framed print)
  - Specify moulding, mat, acrylic, paper
  - Specify shipping address (customer's)
  - Set as drop-ship order
    |
    v
WHCC confirms order (webhook or polling)
    |
    v
Update order status in database
    |
    v
WHCC prints, frames, packages (3-5 days)
    |
    v
WHCC ships directly to customer (white-label)
    |
    v
Tracking number → email to customer
```

**Total cost to you per order (estimated):**
- Framed 8x10: ~$40-55 (product) + $7.95 (drop ship) + $5.50 (premium packaging) = ~$53-68
- Framed 16x20: ~$75-120 (product) + $7.95 (drop ship) + $5.50 (premium packaging) = ~$88-133

**Retail pricing (suggested 3x-4x markup):**
- Framed 8x10: $149-199
- Framed 16x20: $249-349

### Phase 2 (Future): Add Printful/Prodigi for Budget Line

If you ever want to offer a "Standard" tier at a lower price point alongside the WHCC "Premium" tier, Printful or Prodigi would work for a $79-99 framed product. This would be a different quality level (giclée matte vs. archival photographic), but still respectable for budget-conscious customers.

---

## Immediate Next Steps

1. **Log into WHCC developer portal** at [developer.whcc.com](https://developer.whcc.com/) with your existing account and review the full API documentation
2. **Get API credentials** — register for developer access / OAuth tokens
3. **Test in sandbox** — create a test order via the API to understand the request/response format
4. **Map product AttributeUIDs** — identify the specific moulding, mat, acrylic, and paper combinations you want to offer
5. **Build the integration** — Node.js service that calls WHCC API after proof approval
6. **Set up webhooks or polling** — for order status updates and tracking numbers

---

## Sources

- [WHCC Developer Portal](https://developer.whcc.com/)
- [WHCC Framed Prints](https://www.whcc.com/products/framed-prints/)
- [WHCC Drop Shipping](https://www.whcc.com/products/drop-shipping/)
- [WHCC Integrations](https://www.whcc.com/ordering/integrations/)
- [WHCC GitHub](https://github.com/whcc)
- [Printful API Documentation](https://developers.printful.com/docs/)
- [Printful Framed Posters](https://www.printful.com/custom/wall-art/framed-posters)
- [Printful Framed Poster With Mat](https://www.printful.com/custom/wall-art/framed-posters/framed-poster-with-frame-mat-in)
- [Prodigi API Reference](https://www.prodigi.com/print-api/docs/reference/)
- [Prodigi Print API Docs](https://www.prodigi.com/print-api/docs/)
- [Prodigi Classic Frames](https://www.prodigi.com/products/wall-art/framed-prints/classic-frames/)
- [Gooten Framed Prints](https://www.gooten.com/print-on-demand/framed-prints/)
- [Gooten Premium Framed Prints](https://www.gooten.com/print-on-demand/premium-framed-prints/)
- [Gooten API](https://www.gooten.com/print-on-demand/gooten-api/)
- [Frame It Easy 3PL for Artists](https://www.frameiteasy.com/learn/3pl-for-artists/)
- [Frame It Easy API (Postman)](https://documenter.getpostman.com/view/7462304/Tz5s3bQB)
- [Frame It Easy Resellers](https://www.frameiteasy.com/resellers)
- [ShipStation Shipping API](https://www.shipstation.com/shipping-api/)
- [ACI Lab Ordering](https://acilab.com/order-now/)
- [Imagely Automated Print Fulfillment](https://www.imagely.com/automated-print-fulfillment/)
- [Spark Shipping WHCC Integration](https://www.sparkshipping.com/integrations/whcc-white-house-custom-colour)
