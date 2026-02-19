# STILL BESIDE ME — PROMPT.md v2

> **Master development spec.** Read in full before writing any code. This defines the product, business logic, customer experience, infrastructure, and build sequence.

---

## 1. What This Is

**Still Beside Me** is a personalized memorial wall art brand. Customers upload photos, share memories and details about a deceased loved one (person or pet), see a beautiful live preview of their custom memorial piece, approve a proof, and receive a professionally printed canvas or poster shipped to their door.

**This is not a design tool. This is a store.**

Every screen, every form field, every interaction exists to do two things:
1. Help someone honor someone they love
2. Complete the sale

**Tagline:** *Keep them beside you.*  
**Brand email:** david.stillbesideme@gmail.com  
**Domain:** stillbesideme.com

---

## 2. The Emotional Engine (READ THIS FIRST)

This product sells because grief is universal and love is permanent. The customer is not buying a canvas — they're buying the feeling of keeping someone close.

**Every form field is a selling moment.** When you ask someone to type their dog's name, they're not filling out a form — they're saying that name again. When you ask for a favorite memory, they're reliving it. When you ask what made them special, they're smiling through tears. By the time they see the preview with all of those details beautifully composed, they're emotionally invested. The preview IS the product. If it makes them feel something, they buy.

**Design implications:**
- Form fields are not a checklist to rush through. They're a guided emotional journey.
- Use warm, gentle microcopy. Not "Enter pet name" — instead: "What did you call them?"
- Progress through the form should feel like telling a story about the loved one, not filling out a form.
- The preview should update as they go, so they see their words becoming art in real-time.
- NEVER show a price until they've seen the preview with their content in it.
- Upsell moments happen when emotion is highest — right after they see the preview, right after they approve the proof.

**Upsell opportunities (build into the flow):**
- "Add a second photo — maybe their favorite toy, or a photo of you together?" (multi-photo template upgrade)
- "Would you like a custom poem written just for [pet name]?" (AI poem add-on)
- "Many families order a second piece for a parent or sibling. Save 20% on a second memorial." (post-checkout)
- "Add a desktop companion piece — a 5×7 version for your nightstand." (size upsell)
- "Include a matching ornament for the holidays." (product cross-sell, Phase 2)

---

## 3. Architecture & Infrastructure

### 3.1 Where This Lives

This app lives inside the `heroesliveforever` repository as a subfolder with its own routes, frontend, data, and templates. It shares the Express server.

```
heroesliveforever/
├── server.js                    ← Modified: mount SBM routes
├── package.json                 ← Modified: add new deps
├── public/                      ← HLF frontend (unchanged)
├── src/                         ← HLF backend (unchanged)
├── stillbesideme/               ← ★ EVERYTHING SBM
│   ├── public/                  ← Customer-facing frontend
│   │   ├── index.html           ← Landing / storefront
│   │   ├── customize.html       ← Customizer (the money page)
│   │   ├── cart.html            ← Cart & checkout
│   │   ├── account.html         ← Customer account / order history
│   │   ├── proof.html           ← Proof approval page
│   │   ├── order-status.html    ← Order tracking
│   │   ├── contact.html         ← Customer service / help
│   │   ├── css/
│   │   │   ├── store.css
│   │   │   ├── customizer.css
│   │   │   └── account.css
│   │   ├── js/
│   │   │   ├── store.js         ← Template browsing, collections
│   │   │   ├── customizer.js    ← Photo upload, memory form, preview
│   │   │   ├── preview.js       ← Canvas-based live preview renderer
│   │   │   ├── cart.js          ← Cart management, checkout
│   │   │   ├── account.js       ← Login, registration, order history
│   │   │   └── proof.js         ← Proof review & approval
│   │   └── img/                 ← Brand assets, template thumbnails
│   ├── src/
│   │   ├── routes/
│   │   │   ├── pages.js         ← HTML page serving
│   │   │   ├── api.js           ← Core API (images, poems, export)
│   │   │   ├── templates.js     ← Template data endpoints
│   │   │   ├── orders.js        ← Order lifecycle (create, proof, approve, track)
│   │   │   └── auth.js          ← Guest sessions, accounts, login
│   │   ├── data/
│   │   │   ├── templates/       ← Template definitions (JSON per template)
│   │   │   ├── poems.js         ← Built-in poem library
│   │   │   └── printSpecs.js    ← Print product specs & pricing
│   │   ├── services/
│   │   │   ├── poemGenerator.js ← AI poem generation (Anthropic API)
│   │   │   ├── proofRenderer.js ← Server-side proof/preview render
│   │   │   ├── printExporter.js ← Print-ready file generation
│   │   │   ├── orderManager.js  ← Order state machine
│   │   │   ├── emailService.js  ← Transactional emails (proof ready, order shipped)
│   │   │   └── storage.js       ← Image storage abstraction (local → S3)
│   │   └── db/
│   │       ├── database.js      ← SQLite database setup
│   │       ├── migrations/      ← Schema migrations
│   │       └── models/          ← Order, Customer, Session models
│   ├── uploads/                 ← Customer photos (gitignored)
│   └── output/                  ← Generated proofs & print files (gitignored)
```

### 3.2 Server Integration

```javascript
// In server.js — mount SBM alongside HLF
app.use('/sbm', express.static(path.join(__dirname, 'stillbesideme', 'public')));
app.use('/sbm', require('./stillbesideme/src/routes/pages'));
app.use('/sbm/api', require('./stillbesideme/src/routes/api'));
app.use('/sbm/api/templates', require('./stillbesideme/src/routes/templates'));
app.use('/sbm/api/orders', require('./stillbesideme/src/routes/orders'));
app.use('/sbm/api/auth', require('./stillbesideme/src/routes/auth'));
```

**SBM:** `http://localhost:3001/sbm/`  
**HLF:** `http://localhost:3001/` (unchanged)

### 3.3 Database

SQLite via `better-sqlite3`. No external database server needed for MVP. Single file, zero config, handles thousands of orders. Migrate to PostgreSQL when volume demands it.

**Tables:**
- `customers` — id, email, name, password_hash, created_at
- `sessions` — id, customer_id (nullable for guests), cart_data, created_at, expires_at
- `orders` — id, customer_id, session_id, status, template_id, product_sku, fields_json, photos_json, poem_text, proof_url, print_file_url, shipping_json, total_cents, created_at, updated_at
- `order_events` — id, order_id, event_type, data_json, created_at (full audit trail)

**Order statuses:** `draft` → `submitted` → `proof_ready` → `proof_approved` → `in_production` → `shipped` → `delivered`

### 3.4 Image Storage & Quality

**The problem:** Customer photos are the product. They must be stored safely, served fast, and preserved at original quality. Customers upload everything from 8MP phone photos to tiny 200px Facebook screenshots.

**MVP approach (launch):**
- Store uploads in `stillbesideme/uploads/` on the server filesystem
- Organize by date: `uploads/2026/02/19/{uuid}.{ext}`
- Keep originals untouched — never overwrite or compress the source file
- Generate a display-quality thumbnail (800px wide, JPEG 85%) for preview rendering
- Generate a print-quality version only at export time (preserve maximum resolution)

**Phase 2 approach (when scaling):**
- Migrate to S3-compatible storage (AWS S3, Backblaze B2, or Cloudflare R2)
- `storage.js` abstracts the interface so the switch is transparent
- CloudFront or R2 CDN for fast customer-facing thumbnail delivery
- Lifecycle policy: delete uploads after 90 days for completed orders, keep indefinitely for active accounts

**Image quality handling:**
- Accept: JPEG, PNG, WebP, HEIC (iPhone native). Max 50MB per file.
- On upload: extract dimensions, calculate effective DPI at target print size
- Quality tiers (shown to customer):
  - **Excellent** (≥200 DPI at print size): "This photo will look beautiful"
  - **Good** (150-199 DPI): "This photo will print well" (no warning needed)
  - **Usable** (100-149 DPI): Gentle note: "This photo is a bit small but we'll make it look its best. For the sharpest print, a higher resolution version would help."
  - **Low** (<100 DPI): Honest but kind: "This photo is quite small and may appear soft when printed at this size. It will still be meaningful — would you like to try a smaller print size for better quality?"
- **NEVER hard-reject a photo.** These are memorial photos. The customer may not have a better version. Let them make the choice.
- Auto-enhance: Subtle sharpening + slight contrast boost on lower-quality uploads (Sharp can do this). Don't overdo it.

**Storage budget estimate:**
- Average upload: 3-5MB per photo
- 2-3 photos per order average
- 100 orders/month = ~1.5GB/month
- 1 year = ~18GB. Trivially small. Not a concern until thousands of orders/month.

### 3.5 Hosting

**MVP (launch):**
- Single VPS on Railway, Render, or DigitalOcean ($10-20/month)
- Node.js server handles everything: pages, API, image processing, proof generation
- SQLite database file lives on the same server
- Customer uploads stored on server disk
- SSL via Let's Encrypt or platform-provided

**Phase 2 (scaling):**
- Separate static frontend (Netlify/Vercel) from API backend
- S3 for image storage
- Managed PostgreSQL
- Queue system for proof generation (don't block the request)

---

## 4. Design System

### Brand Personality
- **Warm, modern, intimate.** NOT funeral home. NOT Hallmark.
- Think: the feeling of looking at a photo on your nightstand and smiling through tears.
- The product is about love, not loss. About presence, not absence.

### Color Palette

| Role | Color | Hex | Usage |
|------|-------|-----|-------|
| Primary | Warm Charcoal | `#2C2C2C` | Text, headers |
| Secondary | Sage | `#8B9D83` | CTA buttons, active states |
| Warm | Dusty Gold | `#C4A882` | Accents, highlights, premium feel |
| Background | Cream | `#FAF8F5` | Page background |
| Surface | White | `#FFFFFF` | Cards, panels |
| Muted | Warm Gray | `#9B9590` | Secondary text, borders |
| Border | Light Warm | `#E8E4DF` | Dividers, card borders |
| Error | Soft Rose | `#C47070` | Validation (gentle, not angry red) |
| Success | Sage Dark | `#6B7D63` | Confirmations |

### Typography

| Role | Font | Weight | Fallback |
|------|------|--------|----------|
| Logo / Template Headings | Cormorant Garamond | 300, 400, 500 | Georgia, serif |
| Body / UI | Source Sans 3 | 400, 600 | system-ui, sans-serif |
| Template Accent | Playfair Display | 400, 700 | Georgia, serif |

### UI Principles
- Mobile-first. 70%+ traffic from Facebook/Instagram on phones.
- Generous whitespace. Photography-forward.
- No clip art. No angels. No butterflies. No cheap gradients.
- Rounded corners (8px), subtle shadows (0 2px 8px rgba(0,0,0,0.08)).
- Forms should feel like a conversation, not a spreadsheet.

---

## 5. Template System

### 5.1 Template Definition

Each template supports **one or more customer photos** plus rich text fields:

```json
{
  "id": "pet-rainbow-bridge",
  "name": "Rainbow Bridge",
  "collection": "pet-memorial",
  "description": "A beloved poem with your pet's photo, name, and dates",
  "thumbnail": "pet-rainbow-bridge-thumb.jpg",
  "category": "pet",
  "maxPhotos": 1,
  "poemSupport": "library",

  "canvas": {
    "width": 4800,
    "height": 6000,
    "dpi": 300,
    "background": "#1a1a1a"
  },

  "layers": [
    {
      "id": "background",
      "type": "solid",
      "color": "#1a1a1a"
    },
    {
      "id": "photo-main",
      "type": "image",
      "x": 600, "y": 400,
      "width": 3600, "height": 3600,
      "fit": "cover",
      "position": "center center",
      "mask": "rounded-rect",
      "maskRadius": 60,
      "border": { "width": 8, "color": "#C4A882" },
      "photoSlot": "main",
      "label": "Their favorite photo"
    },
    {
      "id": "pet-name",
      "type": "text",
      "x": 2400, "y": 4200,
      "maxWidth": 3200,
      "align": "center",
      "font": "Cormorant Garamond",
      "weight": 500, "size": 180,
      "color": "#FAF8F5",
      "field": "petName"
    },
    {
      "id": "dates",
      "type": "text",
      "x": 2400, "y": 4450,
      "maxWidth": 3200,
      "align": "center",
      "font": "Source Sans 3",
      "weight": 400, "size": 72,
      "color": "#9B9590",
      "field": "dates"
    },
    {
      "id": "poem-text",
      "type": "text",
      "x": 2400, "y": 4700,
      "maxWidth": 3400,
      "align": "center",
      "font": "Cormorant Garamond",
      "weight": 300, "size": 64,
      "lineHeight": 1.6,
      "color": "#C4A882",
      "field": "poemText"
    }
  ],

  "photoSlots": [
    { "id": "main", "label": "Their favorite photo", "required": true },
    { "id": "secondary", "label": "A photo of their favorite toy, or a picture of you together", "required": false }
  ],

  "memoryFields": [
    { "id": "petName", "label": "What did you call them?", "type": "text", "required": true, "maxLength": 40, "displayOnProduct": true },
    { "id": "petNicknames", "label": "Any nicknames?", "sublabel": "The silly ones count too", "type": "text", "required": false, "maxLength": 80, "displayOnProduct": false, "usedFor": ["poem"] },
    { "id": "dates", "label": "Years together", "sublabel": "e.g. 2012 – 2024", "type": "text", "required": false, "maxLength": 30, "displayOnProduct": true },
    { "id": "petType", "label": "What kind of companion?", "type": "select", "options": ["Dog", "Cat", "Bird", "Horse", "Rabbit", "Other"], "required": true, "displayOnProduct": false, "usedFor": ["poem"] },
    { "id": "breed", "label": "Breed", "type": "text", "required": false, "maxLength": 40, "displayOnProduct": false, "usedFor": ["poem"] },
    { "id": "personality", "label": "What made them special?", "sublabel": "The thing that made them uniquely yours", "type": "textarea", "required": false, "maxLength": 200, "displayOnProduct": false, "usedFor": ["poem", "display-optional"] },
    { "id": "favoriteMemory", "label": "A favorite memory", "sublabel": "The one that makes you smile", "type": "textarea", "required": false, "maxLength": 300, "displayOnProduct": false, "usedFor": ["poem"] },
    { "id": "poemText", "label": "Poem or message", "type": "poem-selector", "default": "rainbow-bridge" }
  ],

  "printProducts": [
    { "sku": "canvas-12x16", "label": "Canvas 12×16\"", "price": 3995 },
    { "sku": "canvas-16x20", "label": "Canvas 16×20\"", "price": 4995, "default": true, "badge": "Most Popular" },
    { "sku": "poster-16x20", "label": "Art Print 16×20\"", "price": 2995 }
  ]
}
```

### 5.2 Multi-Photo Templates

Some templates support 2-3 photos. The secondary photo slots are **upsell opportunities AND emotional hooks:**

- "Upload a photo of their favorite toy" — immediately evokes a specific memory
- "A photo of you together" — deepens emotional investment
- "Their favorite spot in the house" — creates a richer, more personal piece

Multi-photo templates are more valuable products (and more emotionally invested customers). Price them $5-10 higher.

### 5.3 Memory Fields vs Display Fields

Every field the customer fills in serves one or more purposes:

| Purpose | Field appears... | Example |
|---------|-----------------|---------|
| **Display on product** | Rendered on the canvas/print | Name, dates |
| **Feed AI poem** | Sent to poem generator prompt | Personality, favorite memory, nicknames |
| **Emotional investment** | Keeps customer engaged, deepens commitment | All of the above |
| **Optional display** | Can be tastefully shown if template supports it | "Beloved companion of the Hamilton family" |

The key insight: **fields that don't appear on the product still sell the product.** Asking someone to describe a favorite memory makes them more likely to buy. The act of remembering IS the experience.

---

## 6. Customer Journey (The Money Flow)

### Step 1: DISCOVER → Storefront Landing Page

Customer arrives from Facebook ad, Instagram, Etsy, Google, or direct. They see:

1. **Emotional hero section** — A gorgeous canvas hanging in a warm living room. Headline: "Keep them beside you." Subhead: "Create a personalized memorial that celebrates the one you love." CTA: "Create Your Memorial"
2. **Collection cards** — Pet Memorials, In Loving Memory, Fishing In Heaven, First Responder. Beautiful photography. Click to filter.
3. **Template grid** — Each template as a card with preview. Hover/tap shows "Personalize This" button.
4. **Social proof** — Testimonials, review count, "Over X memorials created" counter.
5. **How it Works** — 3 illustrated steps: Choose → Personalize → Receive.

### Step 2: PERSONALIZE → Customizer Page

This is where emotion builds and the sale happens. The customer should feel like they're **telling the story** of their loved one, not configuring a product.

**Layout:**
- Desktop: 60% left = live preview | 40% right = memory form
- Mobile: Preview on top (sticky on scroll) | form below

**Form flow (ORDERED for emotional escalation):**

1. **Upload their photo** — Big, beautiful upload area. "Share their favorite photo." Immediate preview update when uploaded.

2. **Tell us about them** — Name, nicknames, dates. Preview updates in real-time as they type.

3. **What made them special?** — Personality, breed, favorite things. These are optional but framed as invitations, not requirements. "Help us make this personal."

4. **A favorite memory** — Open textarea. "The one that makes you smile." This is the emotional peak of the form.

5. **Choose their poem or message** — Three options:
   - Select from poem library (dropdown with inline preview of each poem)
   - "Write a custom poem just for [petName]" → AI poem generator (THE DIFFERENTIATOR)
   - "Write your own message" → free textarea

6. **Add another photo?** (upsell moment) — "Would you like to include a photo of their favorite toy, or a picture of you together?" Unlocks multi-photo template variant.

7. **Preview check** — Full preview with all content. "This is what your memorial will look like." Pause here. Let them look at it. Let it hit them.

8. **Select size** — ONLY after they've seen and loved the preview. Show sizes with prices. Highlight "Most Popular."

9. **Add to Cart** — Not "Buy Now." They may want to order more than one.

### Step 3: CART → Cart & Checkout

**Cart page shows:**
- Thumbnail of their customized piece
- Template name, size, price
- "Add another memorial" CTA (post-cart upsell)
- "Save 20% on a second piece" (discount upsell)

**Checkout options:**
- **Guest checkout** — Email + shipping address. Creates a guest session with order access link sent via email.
- **Create account** — Email + password + shipping address. Can track orders, reorder, save details.
- **Sign in** — Returning customer.

**Payment:** Stripe (Phase 1). Cards, Apple Pay, Google Pay.

**Post-checkout:**
- Order confirmation page with order number
- Confirmation email with proof timeline: "Your proof will be ready within 24 hours."
- Account creation prompt (for guests): "Create an account to track your order and save 20% on future memorials."

### Step 4: PROOF → Proof Approval

**Within 24 hours of order** (target: 1-4 hours with automation):

1. System generates a high-resolution proof image matching the final print output.
2. Customer receives email: "Your memorial for [petName] is ready for your review."
3. Email links to proof page showing:
   - Full proof image at high quality
   - All details listed (name, dates, poem text) for text verification
   - Two buttons: **"Approve & Print"** and **"Request Changes"**

**If approved:** Order moves to `in_production`. Print file generated and sent to fulfillment.

**If changes requested:** Customer can edit text fields and resubmit. New proof generated. (Photo changes require contacting support for MVP; self-service photo replacement in Phase 2.)

**Auto-approve option:** During checkout, customer can check "I've reviewed everything — skip the proof and ship faster!" Order goes directly to production.

### Step 5: FULFILL → Production & Shipping

**Print-ready file generation (see Section 9 for specs):**
- System generates the final print file at exact fulfillment partner specifications
- File is a high-res PNG or PDF with bleed, safe areas, and color profile baked in

**Fulfillment options (flexible — not locked to one provider):**

**Option A: Printful API (primary for launch)**
- Automated: order approved → API call → Printful prints and ships
- Canvas wraps: 0.75" or 1.5" frame depth
- Products: Canvas (multiple sizes), poster, framed poster
- Printful API accepts PNG/JPEG via URL, handles production + shipping + tracking
- Tracking number pushed back via webhook → customer notification

**Option B: Local print shop drop-ship**
- For premium/custom orders or if Printful quality doesn't meet standards
- Generate a standardized print-ready package (see Section 9.2)
- Email package to partner print shop
- They print, frame, ship directly to customer
- Manual tracking entry in admin

**Option C: Hybrid**
- Standard orders → Printful (automated, faster)
- Premium/large format → local partner (higher quality)

### Step 6: TRACK → Order Status

Customer can check order status at any time via:
- Link in confirmation/shipping emails
- Account dashboard (if registered)
- Order lookup page (enter email + order number for guests)

Status page shows:
- Current status with visual timeline
- Tracking number + carrier link when shipped
- Estimated delivery date
- "Need help?" → contact link

### Step 7: DELIGHT → Post-Delivery

**Automated email 7 days after delivery:**
- "How does it look? We'd love to see it hanging in your home."
- Invite to share photo on social with #StillBesideMe
- "Create another memorial" CTA with 15% returning customer discount
- Review request

---

## 7. AI Pet Poem Generator

The #1 differentiator. Nobody else does personalized AI poems.

### How It Works

In the customizer, when customer selects "Write a custom poem just for [petName]":

1. System gathers all memory fields the customer has entered:
   - Pet name, type, breed
   - Personality / what made them special
   - Favorite memory
   - Nicknames

2. Customer clicks "Create [petName]'s Poem" button.

3. Backend calls Anthropic API with crafted prompt (see below).

4. Poem appears in preview, animated line by line (not instant — let the moment land).

5. Customer can:
   - **Keep it** → poem locks into the template
   - **Try another** → regenerate (max 3 per session)
   - **Edit it** → manual text editing on the generated poem
   - **Start over** → clear and re-enter details

### AI Prompt

```
You are writing a short memorial poem for a beloved pet who has passed away. This poem will be printed on a beautiful wall art canvas that will hang in the owner's home for years.

Pet Details:
- Name: {petName}
- Nicknames: {nicknames || "none provided"}
- Type: {petType}
- Breed: {breed || "not specified"}
- What made them special: {personality || "not provided"}
- A favorite memory: {favoriteMemory || "not provided"}

Write a 6-8 line poem that:
- References the pet by name at least once
- Incorporates at least one specific detail the owner shared
- Feels warm and comforting — about love and presence, not just grief
- Is personal and unique, never generic
- Is appropriate for permanent display as wall art (timeless, dignified)
- Does NOT use clichés like "rainbow bridge" or "angel wings" unless the owner specifically referenced them
- Has natural line breaks suitable for display on a memorial canvas
- Could make someone smile through tears

Return ONLY the poem text. No title, no attribution, no explanation.
```

### Technical Details

```
POST /sbm/api/poem/generate
Body: { petName, petType, breed, nicknames, personality, favoriteMemory }
Response: { poem, generationId }
```

- Model: `claude-sonnet-4-5-20250929` (fast, cheap, excellent for short creative)
- Rate limit: 5 generations per session per hour
- Cache generated poems by session (customer can page back to previous versions)
- Requires `ANTHROPIC_API_KEY` in `.env`

---

## 8. Customer Accounts & Sessions

### Guest Flow
- Session created on first visit (cookie-based)
- Cart state stored in session
- At checkout: email + shipping only
- Order access via emailed link (unique token)
- Post-checkout: "Create an account to track this and future orders"

### Account Flow
- Registration: email + password (bcrypt hash)
- Login: email + password → session token
- Account dashboard shows:
  - Order history with status
  - Saved shipping addresses
  - "Create New Memorial" button
  - Reorder from past orders

### Session Data
- Cart contents
- In-progress customization state (so they can leave and come back)
- Generated poem cache
- Uploaded photo references

Sessions expire after 30 days of inactivity. Cart data preserved for 7 days (send "You left something behind" email for abandoned carts — Phase 2).

---

## 9. Print-Ready File Generation

### 9.1 Printful Canvas Specifications

Canvas prints have a **wrap area** — the image extends around the wooden frame edges. For a 1.5" deep frame, you need 1.5" of image on each side beyond the visible face.

| Product | Face Size | Wrap | Total Print Area | At 300 DPI |
|---------|-----------|------|-----------------|------------|
| Canvas 12×16" | 12×16" | 1.5" each side | 15×19" | 4500×5700 px |
| Canvas 16×20" | 16×20" | 1.5" each side | 19×23" | 5700×6900 px |
| Canvas 24×36" | 24×36" | 1.5" each side | 27×39" | 8100×11700 px |
| Poster 16×20" | 16×20" | 0.125" bleed | 16.25×20.25" | 4875×6075 px |

**Safe area:** All text and critical photo content must be ≥0.5" inward from the face edge (to avoid wrapping around the frame edge).

**File format:** PNG, sRGB color profile, 300 DPI. No transparency.

### 9.2 Standard Print-Ready Package (For Local Print Shops)

For orders fulfilled by a local print/frame partner instead of Printful, generate a **print package folder** containing:

```
order-SBM-00042/
├── print-file.png              ← Full-resolution print file with bleed
├── proof.png                   ← What customer approved (for reference)
├── order-details.txt           ← Human-readable order summary
│   - Customer: Jane Smith
│   - Product: Canvas 16×20" (1.5" wrap)
│   - Template: Rainbow Bridge
│   - Ship to: [address]
│   - Special instructions: [any notes]
├── print-specs.json            ← Machine-readable specs
│   - dimensions, DPI, color profile, product type
│   - bleed area, safe area coordinates
└── photos/                     ← Original customer photos (highest resolution)
    ├── main.jpg
    └── secondary.jpg (if applicable)
```

This folder can be zipped and emailed to any print/frame shop. It contains everything they need to produce and ship the order without any back-and-forth.

### 9.3 Render Pipeline

1. Load template definition + customer's photos + customer's text
2. Build an HTML page at exact print pixel dimensions
3. Render with Puppeteer at 1x scale (dimensions ARE the DPI-correct pixel count)
4. For canvas: extend background/photo into wrap bleed area
5. For proof: render at face size only (no bleed) at 150 DPI for fast delivery
6. Output PNG, sRGB, no alpha channel
7. Store output file, update order record with URL

---

## 10. Collections & Templates

### Phase 1 Launch: Pet Memorials

| Template ID | Name | Photos | Poem Support | Description |
|-------------|------|--------|-------------|-------------|
| `pet-rainbow-bridge` | Rainbow Bridge | 1 | Library | Classic poem, elegant dark background, photo + name/dates |
| `pet-forever-loved` | Forever Loved | 1 | None (name/dates only) | Minimal modern. Big photo, clean type. Light and dark variants. |
| `pet-custom-poem` | In Your Own Words | 1 | AI-generated | The differentiator. Custom poem written for their specific pet. |
| `pet-together` | Always Together | 2 | Library or AI | Primary photo + second photo (toy, owner together, favorite spot). Premium. |
| `pet-paw-prints` | Paw Prints On My Heart | 1 | Short message | Subtle paw texture, warm tones, space for a personal sentence. |

### Phase 2 (Week 2): Human Memorials

| Template ID | Name | Photos | Poem Support | Description |
|-------------|------|--------|-------------|-------------|
| `human-letter-heaven` | Letter From Heaven | 1 | Fixed poem | #1 bestselling format in the entire memorial canvas market. |
| `human-classic` | Forever In Our Hearts | 1 | Library | Elegant portrait, name, dates, poem selection. |
| `human-modern` | Always With Us | 1-2 | Library or custom | Contemporary design, optional second photo. |

### Phase 2 (Week 2): Hobby/Niche

| Template ID | Name | Photos | Poem Support | Description |
|-------------|------|--------|-------------|-------------|
| `fishing-heaven` | Gone Fishing | 1 | Library | Rustic outdoor aesthetic, water/nature textures. |
| `fishing-heaven-2` | The Big Catch | 1-2 | Library | Bolder design, celebration tone. |
| `firefighter-memorial` | Into The Fire | 1 | Library | Badge number, station, dates. Firefighter-appropriate. |
| `police-memorial` | End of Watch | 1 | Library | Thin blue line aesthetic. Badge, department. |

---

## 11. Pricing & Products

| Product | Cost (Printful) | Our Price | Margin |
|---------|----------------|-----------|--------|
| Canvas 12×16" | ~$16 | $39.95 | $24 (60%) |
| Canvas 16×20" | ~$20 | $49.95 | $30 (60%) |
| Poster 16×20" | ~$8 | $29.95 | $22 (73%) |
| AI Custom Poem add-on | ~$0.02 (API cost) | $9.95 | ~100% |
| Second Photo upgrade | $0 | $5.00 | 100% |

**Shipping:** Baked into price or flat $5.95 (test which converts better). Printful charges ~$5-8 for US shipping.

**Discounts:**
- 20% off second piece in same order
- 15% returning customer (emailed post-delivery)
- Abandoned cart: 10% off (email sent 24hr after abandonment)

---

## 12. Contact & Customer Service

### Contact Page (`/sbm/contact.html`)
- Email: hello@stillbesideme.com (forward to david.stillbesideme@gmail.com for MVP)
- Contact form: name, email, order number (optional), message
- FAQ section:
  - How long does shipping take? (5-10 business days)
  - Can I change my order after approving? (Contact us within 24 hours)
  - What if my photo is low quality? (We'll do our best — you can also send us a higher quality version)
  - What if I'm not happy with the print? (We'll work with you to make it right)
  - Do you ship internationally? (Currently US only, more coming soon)

### Support Touchpoints
- Pre-purchase: FAQ, contact form
- During customization: Help tooltips on form fields, photo quality guidance
- Post-order: Order status page, proof approval flow, email support
- Post-delivery: Satisfaction check email, easy contact for issues

---

## 13. Environment Variables

```env
# Add to .env
ANTHROPIC_API_KEY=sk-ant-...     # AI poem generation
STRIPE_SECRET_KEY=sk_...          # Payment processing
STRIPE_PUBLISHABLE_KEY=pk_...     # Frontend Stripe.js
PRINTFUL_API_KEY=...              # Printful order submission (Phase 2)
SESSION_SECRET=...                # Express session signing
SMTP_HOST=...                     # Email sending (or use SendGrid/Mailgun)
SMTP_USER=...
SMTP_PASS=...
BASE_URL=https://stillbesideme.com
```

---

## 14. Dependencies to Add

```bash
npm install better-sqlite3        # Database
npm install @anthropic-ai/sdk     # AI poems
npm install stripe                 # Payments
npm install bcryptjs               # Password hashing
npm install express-session        # Sessions
npm install connect-sqlite3        # Session store
npm install nodemailer             # Email
npm install heic-convert           # iPhone photo support
```

---

## 15. Build Sequence

**Build in this order. Each phase is testable before the next.**

### Phase 1: Foundation (Days 1-2)
- [ ] Create `stillbesideme/` directory structure
- [ ] Mount SBM routes in `server.js`
- [ ] SQLite database setup with migrations
- [ ] Basic `index.html` storefront shell with brand CSS
- [ ] Basic `customize.html` customizer shell
- [ ] Session management (cookie-based, DB-backed)
- [ ] Verify: `/sbm/` serves storefront, `/sbm/customize.html` serves customizer

### Phase 2: Image Upload & Preview (Days 3-4)
- [ ] Image upload endpoint (Multer, organized storage)
- [ ] HEIC conversion, thumbnail generation
- [ ] DPI/quality assessment
- [ ] Upload UI: drag-drop, click-browse, mobile camera
- [ ] Canvas-based live preview renderer
- [ ] Photo appears in template preview immediately on upload
- [ ] Smart auto-crop using Sharp entropy analysis (reuse HLF pattern)

### Phase 3: Memory Collection & Live Preview (Days 5-6)
- [ ] Template data structure and API endpoints
- [ ] Dynamic form generation from template's `memoryFields`
- [ ] Real-time preview updates as customer types
- [ ] Warm, emotional microcopy on all form fields
- [ ] Poem library with dropdown selector and inline preview
- [ ] 4-5 pet memorial templates fully defined and rendering

### Phase 4: AI Poem Generator (Day 7)
- [ ] Anthropic API integration
- [ ] `/sbm/api/poem/generate` endpoint
- [ ] "Write a custom poem for [petName]" UI flow
- [ ] Animated poem reveal in preview
- [ ] Regeneration (up to 3x), manual editing
- [ ] Poem caching in session

### Phase 5: Cart & Checkout (Days 8-10)
- [ ] Size/product selector with pricing
- [ ] Cart management (add, remove, update)
- [ ] Cart page with order summary
- [ ] Guest checkout form (email + shipping)
- [ ] Account creation option
- [ ] Login for returning customers
- [ ] Stripe payment integration
- [ ] Order creation in database
- [ ] Confirmation page and email

### Phase 6: Proof & Fulfillment (Days 11-13)
- [ ] Server-side proof renderer (Puppeteer at proof resolution)
- [ ] Proof approval page with approve/request-changes
- [ ] Print-ready file generator (full resolution with bleed)
- [ ] Standard print package generator (for local fulfillment)
- [ ] Printful API integration (submit approved orders automatically)
- [ ] Order status tracking page
- [ ] Shipping notification emails

### Phase 7: Storefront & Polish (Days 14-16)
- [ ] Beautiful landing page with emotional hero section
- [ ] Collection browsing with filtering
- [ ] Template cards with hover previews
- [ ] How It Works section
- [ ] Contact page with FAQ
- [ ] Mobile responsive polish (every page)
- [ ] SEO basics (title, meta, OG tags)
- [ ] Loading states, error handling, edge cases

### Phase 8: Human & Niche Templates (Week 3)
- [ ] Letter From Heaven template
- [ ] Forever In Our Hearts template
- [ ] Fishing In Heaven templates (2)
- [ ] Firefighter/Police templates
- [ ] Update storefront collections
- [ ] Test full order flow end-to-end for each template

---

## 16. Template Visual Design Guidelines

### Background Treatments
- **Dark Matte:** `#1a1a1a` to `#2C2C2C` — works with any photo, feels premium
- **Warm Textured:** Subtle linen or paper texture overlay at low opacity
- **Nature Gradient:** Deep forest green to dark — for outdoor/fishing themes
- **Service Colors:** Deep navy (police), deep red (fire) — subdued, not bright

### Photo Treatment
- Rounded rect mask with subtle border (2-4px, warm gold `#C4A882` or cream)
- Soft vignette overlay on photo edges — helps ANY photo look intentional
- Dark photos get a subtle brightness/contrast boost
- Light photos get a gentle warm tone overlay
- NEVER sharp rectangle with no treatment. Looks like a placeholder.

### Text Hierarchy
1. **Name:** Largest. Cormorant Garamond 500. White or cream on dark.
2. **Dates:** Smaller. Source Sans 3, 400. Muted gray or warm gold.
3. **Poem/Message:** Medium. Cormorant Garamond 300. Warm accent color.
4. **Attribution:** Smallest. Source Sans 3, 400. Very muted.

### Canvas Wrap Safety
- 1.5" wrap zone on all sides must contain ONLY background — no text, no face, no critical content
- Inner safe zone: minimum 0.5" inward from the face edge
- Template designs must account for this at every size

---

## 17. Critical Reminders

1. **This is a store, not a tool.** Every pixel sells. Every interaction converts. Think like a marketer.

2. **Mobile first.** 70%+ of traffic comes from phones via social media ads. If the customizer doesn't work beautifully on a 375px screen, nothing else matters.

3. **Bad photos are the norm.** These are memorial photos — phone shots of old prints, tiny Facebook pics, screenshots. Make bad photos look their best. Never reject. Always encourage.

4. **The form IS the product experience.** Each question deepens emotional investment. By the time they see the preview, they're already committed. Don't rush the form.

5. **Speed matters.** Preview must update instantly (<100ms). Proof generation should target <60 seconds. Every second of waiting loses customers.

6. **AI poems are the moat.** This is what nobody else offers. The poem must be genuinely moving, not generic. Test with real pet names and real memories. If the poem doesn't make you feel something, the prompt needs work.

7. **Design quality is the product.** If templates look cheap, nothing else matters. Every template should look like something you'd be proud to hang on YOUR wall.

8. **Always be selling.** Every screen should have a CTA. Every interaction should deepen commitment. Upsells are natural, not pushy — "Would you like to include a photo of their favorite toy?" feels caring, not salesy, because in this context it IS caring.

9. **Proofs prevent chargebacks.** The proof approval flow isn't just customer service — it protects the business. A customer who approved their proof can't claim the product was wrong.

10. **The print file is the deliverable.** Whether it goes to Printful, a local shop, or gets downloaded, the print-ready file must be production-perfect every time. Bleed, DPI, color profile, safe areas — no shortcuts.

---

*Build it beautiful. Build it like someone's grandmother is going to cry when she sees it. Because she will.*
