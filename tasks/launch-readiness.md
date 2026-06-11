# Launch Readiness Plan

## Current State
The product is ~85% launch-ready. The customizer, AI poems, image pipeline, templates, 21 SEO landing pages, 8 blog posts, analytics, legal pages, and security hardening are all built. **The critical gap is the checkout-to-fulfillment pipeline** – a customer can build their tribute but can't pay for it yet.

---

## PHASE 1: Can Take Money (Critical Path)
_Without these, you cannot launch._

- [ ] **1a. Stripe live API keys** – Switch from `sk_test_placeholder` to real keys in Railway env vars. Set up webhook endpoint + signing secret.
- [ ] **1b. Cart & pricing UI** – Size/product selector showing prices. Customer needs to pick a size (8x10, 11x14, 16x20) and see the price before checkout.
- [ ] **1c. Checkout flow** – "Add to Cart" → Stripe Checkout Session → order confirmed page. Test end-to-end with Stripe test mode first.
- [ ] **1d. Order creation in database** – On successful payment (webhook), create order record with status `submitted`, store customer info + customization data.

## PHASE 2: Can Fulfill Orders (Must-Have for Launch)
_Without these, you'd take money but can't deliver._

- [ ] **2a. Server-side proof renderer** – Generate a print-ready proof image from the canvas data. Client-side renderer exists; needs server-side equivalent for fulfillment.
- [ ] **2b. Proof approval workflow** – Email customer a proof link → they approve → order moves to `proof_approved` status.
- [ ] **2c. Luma Prints order submission** – After proof approval, auto-submit to Luma API. Integration code exists; needs to be wired into the post-approval flow.
- [ ] **2d. Transactional email** – Set up SMTP (SendGrid, Mailgun, or Gmail SMTP) for: order confirmation, proof ready, shipping notification. Nodemailer is already configured, just needs credentials.

## PHASE 3: Professional Polish (Launch Week)
_These make you look legit and reduce support burden._

- [ ] **3a. Order status page** – Let customers check their order status without emailing you.
- [ ] **3b. Mailchimp integration** – Connect exit-intent popup + footer form to actual Mailchimp list. API proxy exists, needs keys.
- [ ] **3c. Real product photography** – Replace placeholder hero images with photos of actual framed prints.
- [ ] **3d. Meta Pixel + Google Ads** – Replace placeholder IDs with real ones for retargeting from day one.
- [ ] **3e. Sentry DSN** – Activate error monitoring so you catch issues before customers report them.

## PHASE 4: Growth (Post-Launch)
_Build these once you have first orders flowing._

- [ ] **4a. Remaining SEO landing pages** – Build out any missing relationship pages (templates are clone jobs)
- [ ] **4b. Email nurture sequence** – Welcome series for email captures, abandoned cart recovery
- [ ] **4c. Additional templates** – Fishing In Heaven, first responder, etc.
- [ ] **4d. Multi-photo upsell** – Third panel upsell flow in checkout
- [ ] **4e. Customer reviews/photos** – Real testimonials with product photos

---

## Decision Points for You (David)

1. **Stripe:** Do you have a Stripe account set up? Or do you need to create one?
2. **Email provider:** Do you want to use SendGrid (free tier: 100 emails/day), Mailgun, or Gmail SMTP for transactional emails?
3. **Pricing:** What are your prices per size? (Need to know your Luma costs + target margins)
4. **Proof workflow:** Do you want manual proof approval (you review before sending to customer) or auto-generate and send directly to customer?
5. **Launch scope:** Are you comfortable launching with just Phases 1-2 (can take money + fulfill), or do you want Phase 3 polish first?

---

## Estimated Build Order

If we work through this systematically:
- **Phase 1** (1a-1d): Cart UI + Stripe integration + order creation
- **Phase 2** (2a-2d): Proof generation + email + Luma submission
- **Phase 3** (3a-3e): Polish items (can be done incrementally)

Phase 1 is the most impactful – it unblocks revenue.
