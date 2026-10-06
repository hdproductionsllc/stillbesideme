/**
 * Email Service – proof workflow emails.
 *
 * Delivery is transport-agnostic: when SMTP_HOST points at Resend, mail goes
 * out over Resend's HTTPS API (port 443) — Railway's network silently drops
 * outbound SMTP connections (verified 2026-07-19: smtp.resend.com timed out
 * from prod on every port while the HTTPS API delivered instantly). Any other
 * SMTP_HOST still uses Nodemailer, now with hard timeouts so a hung socket
 * can never stall the Stripe webhook path for minutes again.
 */

const nodemailer = require('nodemailer');

const FROM = process.env.EMAIL_FROM || 'Still Beside Me <hello@stillbesideme.com>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

let transporter = null;

function usesResendApi() {
  return /resend/i.test(process.env.SMTP_HOST || '');
}

/** "a@x.com, b@y.com" → ["a@x.com", "b@y.com"] (Resend wants arrays). */
function splitAddresses(value) {
  return String(value).split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Deliver via Resend's HTTPS API. SMTP_PASS is the Resend API key (that is
 * what Resend SMTP auth uses), so no new env var is needed.
 */
async function sendViaResendApi(mailOptions) {
  const fs = require('fs');
  const { from, to, subject, html, text, cc, bcc, attachments } = mailOptions;

  const payload = { from, to: splitAddresses(to), subject };
  if (html) payload.html = html;
  if (text) payload.text = text;
  if (cc) payload.cc = splitAddresses(cc);
  if (bcc) payload.bcc = splitAddresses(bcc);
  if (attachments && attachments.length) {
    payload.attachments = attachments.map(a => ({
      filename: a.filename,
      content: a.path
        ? fs.readFileSync(a.path).toString('base64')
        : Buffer.from(a.content).toString('base64'),
    }));
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RESEND_API_KEY || process.env.SMTP_PASS}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Resend API ${res.status}: ${body.message || JSON.stringify(body)}`);
  }
  return { messageId: body.id };
}

function getTransporter() {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Fail fast: an unreachable SMTP host must error in seconds, not hang the
    // order pipeline (the default is effectively minutes).
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });

  return transporter;
}

/** Single delivery chokepoint for every email this service sends. */
async function deliver(mailOptions) {
  if (!process.env.SMTP_HOST) {
    console.log(`Email (not sent — no SMTP): to=${mailOptions.to} subject="${mailOptions.subject}"`
      + (mailOptions.text ? `\n${mailOptions.text}` : ''));
    return { preview: true };
  }
  const result = usesResendApi()
    ? await sendViaResendApi(mailOptions)
    : await getTransporter().sendMail(mailOptions);
  console.log(`Email sent: to=${mailOptions.to} subject="${mailOptions.subject}" messageId=${result.messageId}`);
  return result;
}

/** Format price from cents */
function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Shared email header/footer HTML */
function wrapHtml(bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#FAF8F5;font-family:'Source Sans Pro',system-ui,-apple-system,sans-serif;">
  <div style="max-width:600px;margin:0 auto;padding:32px 16px;">
    <div style="text-align:center;margin-bottom:32px;">
      <span style="font-family:Georgia,serif;font-size:1.5rem;color:#2C2C2C;letter-spacing:0.5px;">Still Beside Me</span>
    </div>
    ${bodyHtml}
    <div style="text-align:center;margin-top:40px;padding-top:24px;border-top:1px solid #E8E4DF;color:#9B9590;font-size:0.85rem;">
      <p>Still Beside Me &middot; Memorial Art, Made Personal</p>
      <p>Questions? Reply to this email or contact support@stillbesideme.com</p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Every email sent through here quietly BCCs ADMIN_EMAIL, so the shop sees
 * exactly what each customer receives — a paper trail with zero extra code at
 * the call sites. Skipped for any address already in to/cc (review requests,
 * partner mail) so nothing arrives twice.
 */
async function send(to, subject, html, extra = {}) {
  const opts = { from: FROM, to, subject, html, ...extra };
  if (ADMIN_EMAIL && !opts.bcc) {
    const already = [opts.to, opts.cc].filter(Boolean).join(',').toLowerCase();
    const copies = splitAddresses(ADMIN_EMAIL).filter(a => !already.includes(a.toLowerCase()));
    if (copies.length) opts.bcc = copies.join(', ');
  }
  return deliver(opts);
}

/**
 * Plain-text operational alert to ADMIN_EMAIL.
 * Used when an order stalls (proof generation, print render, or fulfillment
 * submit failed) so David can act from his phone. Follows the same
 * log-fallback pattern as every other email: without SMTP it logs instead.
 */
async function sendAdminAlert(subject, textBody) {
  if (!ADMIN_EMAIL) {
    console.warn(`Email: ADMIN_EMAIL not configured — admin alert not sent: "${subject}"`);
    return { skipped: true };
  }
  return deliver({ from: FROM, to: ADMIN_EMAIL, subject, text: textBody });
}

/**
 * Send an order-confirmation email immediately after Stripe webhook fires.
 * This goes out within seconds of payment, before the proof is generated,
 * so the customer is reassured that we received their order.
 */
async function sendOrderConfirmation(to, orderData, statusPageUrl, giftUrl = null) {
  const { orderId, templateName, sku, totalCents } = orderData;
  const shortId = orderId.substring(0, 8).toUpperCase();

  // The one thing flowers still beat us on is speed: they arrive tomorrow, this
  // takes a week and a half on purpose. So a gift sender gets something they can
  // send TODAY — a link to the tribute page, which fills in as the piece is made
  // and which the recipient can also reach later via the QR on the printed note.
  // It is deliberately theirs to send, not ours: we never email the recipient,
  // because we don't ask for their address and the message should come from a
  // friend, not from a company they've never heard of.
  const giftBlock = giftUrl ? `
      <div style="background:#FAF7F2;border:1px solid #E8E4DF;border-radius:8px;padding:20px;margin-bottom:24px;">
        <p style="color:#2C2C2C;line-height:1.6;margin:0 0 12px;font-weight:600;">
          Want them to know today?
        </p>
        <p style="color:#2C2C2C;line-height:1.6;margin:0 0 12px;">
          Their tribute is being made with care, so it will take a little while to reach them &mdash;
          which is rather the point: it arrives once the flowers have gone.
          But if you'd like them to know now, text them this link. It fills in as the piece is finished,
          and it's the same link printed on the note in their box.
        </p>
        <p style="margin:0;word-break:break-all;">
          <a href="${giftUrl}" style="color:#8B9D83;font-weight:600;">${giftUrl}</a>
        </p>
      </div>
  ` : '';

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;margin-bottom:24px;">
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;text-align:center;margin:0 0 8px;">
        Thank you &mdash; we've received your order
      </h1>
      <p style="text-align:center;color:#9B9590;margin:0 0 24px;">
        Order ${shortId} &middot; ${formatPrice(totalCents)}
      </p>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:16px;">
        Your payment was received successfully. The design you approved is now with our team,
        where a real person gives it one final look before it goes to print.
      </p>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:24px;">
        What prints is exactly what you approved on screen. If anything about it is weighing on you
        &mdash; a date, a spelling, a word in the poem &mdash; just reply to this email and we'll catch it
        before it prints.
      </p>

      ${giftBlock}

      <div style="text-align:center;margin-bottom:16px;">
        <a href="${statusPageUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          View order status
        </a>
      </div>

      <p style="text-align:center;color:#9B9590;font-size:0.85rem;margin-top:24px;">
        Save this email &mdash; your order ID is <strong>${shortId}</strong>.
      </p>
    </div>
  `);

  return send(to, `Order confirmed — ${shortId}`, html);
}

/**
 * Gentle recovery email for an abandoned Stripe Checkout.
 *
 * Sent at most once, from handleCheckoutExpired, when a customer got far enough
 * to leave an email at Stripe but didn't complete payment. This person is
 * grieving, so the copy is an open door, never a nudge: no urgency, no
 * countdown, no discount code, no "you left something in your cart." Just the
 * real promises and a warm link back to finish whenever they feel ready.
 *
 * @param {string} to
 * @param {object} orderData — { petName }
 * @param {string} resumeUrl — absolute link that reopens THIS design: the saved
 *        design's ?design= link when the proof step saved one, otherwise the
 *        bare designer (which can only restore from the same browser tab).
 */
async function sendAbandonedCheckoutRecovery(to, orderData, resumeUrl) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const petName = orderData && orderData.petName ? String(orderData.petName).trim() : '';
  const safePet = esc(petName);

  const heading = safePet
    ? `${safePet}'s tribute is here whenever you're ready`
    : `Your tribute is here whenever you're ready`;

  const opening = safePet
    ? `You started a tribute for ${safePet}, and it's still here for you. There's no rush at all. Take all the time you need.`
    : `You started a tribute, and it's still here for you. There's no rush at all. Take all the time you need.`;

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;margin-bottom:24px;">
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;text-align:center;margin:0 0 24px;">
        ${heading}
      </h1>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:16px;">
        ${opening}
      </p>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:24px;">
        Whenever you feel ready, you can pick your tribute back up right where you left off.
      </p>

      <div style="text-align:center;margin-bottom:24px;">
        <a href="${resumeUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          Finish your tribute
        </a>
      </div>

      ${reassuranceBox()}
    </div>
  `);

  const subject = petName
    ? `${petName}'s tribute is here whenever you're ready`
    : `Your tribute is here whenever you're ready`;

  return send(to, subject, html);
}

/** Escape text a visitor typed (their pet's name) before it goes into HTML. */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The three promises every "come back to your tribute" email ends on. One
 * copy, so the abandoned-checkout email and the saved-design emails can never
 * drift into promising different things.
 */
function reassuranceBox() {
  return `
      <div style="background:#FAF7F2;border:1px solid #E8E4DF;border-radius:8px;padding:20px;">
        <p style="color:#2C2C2C;line-height:1.6;margin:0 0 8px;font-weight:600;">
          A few things to set your mind at ease:
        </p>
        <ul style="color:#2C2C2C;line-height:1.7;margin:0;padding-left:20px;">
          <li>You'll see the finished proof before you pay. Nothing is printed until you've read every word and said it's right.</li>
          <li>You can ask for a full refund any time before it goes to print, no questions asked.</li>
          <li>Shipping within the US is always free.</li>
        </ul>
      </div>`;
}

/**
 * Body shared by the two saved-design emails: their pet's photo (served from
 * the token-gated /d/:token/photo route, because an email client carries no
 * session cookie), the button back into the design, and the promises.
 */
function savedDesignHtml({ heading, paragraphs, resumeUrl, photoUrl, footnote }) {
  const photo = photoUrl
    ? `<div style="text-align:center;margin-bottom:24px;">
        <img src="${photoUrl}" alt="" width="220" style="max-width:220px;width:100%;height:auto;border-radius:8px;border:1px solid #E8E4DF;">
      </div>`
    : '';
  return wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;margin-bottom:24px;">
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;text-align:center;margin:0 0 24px;">
        ${heading}
      </h1>
      ${photo}
      ${paragraphs.map(p => `<p style="color:#2C2C2C;line-height:1.6;margin-bottom:16px;">${p}</p>`).join('\n      ')}
      <div style="text-align:center;margin:24px 0;">
        <a href="${resumeUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          Pick up where you left off
        </a>
      </div>
      ${reassuranceBox()}
      <p style="color:#9B9590;font-size:0.85rem;line-height:1.6;margin:20px 0 0;text-align:center;">
        ${footnote}
      </p>
    </div>
  `);
}

/**
 * "Email me my design": sent the moment someone asks for it in the designer.
 *
 * They asked for this, so it is a delivery, not marketing. It says plainly
 * that one reminder follows and offers the way to stop it up front.
 *
 * @param {string} to
 * @param {object} d — { petName, resumeUrl, photoUrl, stopUrl, remindersOn }
 */
async function sendDesignSaved(to, d) {
  const pet = d.petName ? String(d.petName).trim() : '';
  const safePet = escapeHtml(pet);

  const html = savedDesignHtml({
    heading: safePet ? `${safePet}'s tribute is saved` : 'Your tribute is saved',
    photoUrl: d.photoUrl,
    resumeUrl: d.resumeUrl,
    paragraphs: [
      'Everything you made is kept just as you left it: the photo, the words and the frame.',
      'The button below opens it on any phone or computer, and it stays saved for 90 days. Take all the time you need.',
    ],
    footnote: d.remindersOn
      ? `We'll send you one reminder in a couple of days, and then leave you be. <a href="${d.stopUrl}" style="color:#9B9590;">Don't send the reminder</a>`
      : `We won't email you about it again. It stays saved for 90 days.`,
  });

  const subject = pet ? `${pet}'s tribute is saved` : 'Your tribute is saved';
  return send(to, subject, html);
}

/**
 * The one reminder, about two days after a design was saved, only if nothing
 * has been ordered since. Sent by designReminderEngine; never repeated.
 *
 * @param {string} to
 * @param {object} d — { petName, resumeUrl, photoUrl, stopUrl }
 */
async function sendDesignReminder(to, d) {
  const pet = d.petName ? String(d.petName).trim() : '';
  const safePet = escapeHtml(pet);

  const html = savedDesignHtml({
    heading: safePet ? `${safePet}'s tribute is still here` : 'Your tribute is still here',
    photoUrl: d.photoUrl,
    resumeUrl: d.resumeUrl,
    paragraphs: [
      safePet
        ? `Just a note that the tribute you started for ${safePet} is still saved, exactly as you left it.`
        : 'Just a note that the tribute you started is still saved, exactly as you left it.',
      'There is no rush. It will be here whenever you feel ready.',
    ],
    footnote: `This is the only reminder we'll send. <a href="${d.stopUrl}" style="color:#9B9590;">Stop emails about this design</a>`,
  });

  const subject = pet ? `${pet}'s tribute is still here` : 'Your tribute is still here';
  return send(to, subject, html);
}

/**
 * Send proof email to customer with proof image and approval link.
 */
async function sendProofEmail(to, orderData, proofImageUrl, approvalPageUrl, statusPageUrl) {
  const { orderId, templateName, sku, totalCents } = orderData;
  const shortId = orderId.substring(0, 8).toUpperCase();

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;margin-bottom:24px;">
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;text-align:center;margin:0 0 8px;">
        Your design proof is ready
      </h1>
      <p style="text-align:center;color:#9B9590;margin:0 0 24px;">
        Order ${shortId} &middot; ${formatPrice(totalCents)}
      </p>

      <div style="text-align:center;margin-bottom:24px;">
        <img src="${proofImageUrl}" alt="Your tribute proof" style="max-width:100%;border-radius:8px;border:1px solid #E8E4DF;" />
      </div>
      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:24px;">
        We've created your personalized ${templateName || 'tribute'}. Please review the design carefully — once approved,
        it will be ${describePiece(sku).making}.
      </p>

      <div style="text-align:center;margin-bottom:16px;">
        <a href="${approvalPageUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          Review Your Proof
        </a>
      </div>

      <p style="text-align:center;color:#9B9590;font-size:0.85rem;">
        Need changes? You can request revisions from the proof review page.
      </p>
      ${statusPageUrl ? `
      <p style="text-align:center;color:#9B9590;font-size:0.85rem;margin-top:16px;">
        Or <a href="${statusPageUrl}" style="color:#8B9D83;">check your order status</a> anytime.
      </p>` : ''}
    </div>
  `);

  return send(to, `Your design proof is ready — Order ${shortId}`, html);
}

/**
 * Gentle nudge for a proof that is still waiting on the customer's eyes.
 * Sent by the proof-reminder engine (src/services/followupEngine.js) at 3 and
 * 7 days after the proof email, and never more than twice.
 *
 * Deliberately pressure-free: no deadline, no countdown, no offer, nothing
 * that reads as a sales chase. The order is already paid — the only thing this
 * email is allowed to do is quietly reopen the door.
 *
 * @param {string} to — customer email
 * @param {object} orderData — { orderId, petName, templateName, totalCents }
 * @param {string|null} proofImageUrl — absolute URL to the proof image, or null
 * @param {string} approvalPageUrl — the customer's existing /proof/:token page
 * @param {number} reminderNumber — 1 or 2. #2 adds that we're holding their
 *        piece and that a plain reply reaches us.
 */
async function sendProofReminder(to, orderData, proofImageUrl, approvalPageUrl, reminderNumber = 1) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const { orderId, totalCents } = orderData;
  const shortId = orderId ? String(orderId).substring(0, 8).toUpperCase() : '';
  const pet = orderData && orderData.petName ? String(orderData.petName).trim() : '';
  const safePet = esc(pet);
  const isSecond = reminderNumber === 2;

  const possessive = safePet ? `${safePet}'s` : 'your';

  const heading = safePet
    ? `${safePet}'s tribute is ready for your eyes`
    : `Your tribute is ready for your eyes`;

  const opening = isSecond
    ? `${possessive.charAt(0).toUpperCase() + possessive.slice(1)} design proof is still here whenever you'd like to see it. We're holding your piece safely &mdash; it isn't going anywhere, and neither are we.`
    : `We sent ${possessive} design proof a little while ago, and it's still waiting quietly for you. There's no rush at all &mdash; some days are heavier than others, and this will keep.`;

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;margin-bottom:24px;">
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;text-align:center;margin:0 0 8px;">
        ${heading}
      </h1>
      ${shortId ? `
      <p style="text-align:center;color:#9B9590;margin:0 0 24px;">
        Order ${shortId}${totalCents ? ` &middot; ${formatPrice(totalCents)}` : ''}
      </p>` : '<div style="height:16px;"></div>'}

      ${proofImageUrl ? `
      <div style="text-align:center;margin-bottom:24px;">
        <img src="${proofImageUrl}" alt="Your tribute proof" style="max-width:100%;border-radius:8px;border:1px solid #E8E4DF;" />
      </div>` : ''}

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:16px;">
        ${opening}
      </p>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:24px;">
        Nothing is printed until you've seen it and told us it's right. Whenever you're ready,
        you can look it over and either approve it or ask for changes.
      </p>

      <div style="text-align:center;margin-bottom:24px;">
        <a href="${approvalPageUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          See your proof
        </a>
      </div>

      <div style="background:#FAF7F2;border:1px solid #E8E4DF;border-radius:8px;padding:20px;">
        <p style="color:#2C2C2C;line-height:1.7;margin:0;">
          Take all the time you need. Your proof stays at that link, and nothing goes to print
          without your approval.${isSecond ? ` If something isn't right &mdash; a word, the photo, or simply the timing &mdash; you can reply straight to this email and we'll help.` : ''}
        </p>
      </div>
    </div>
  `);

  const subject = isSecond
    ? (pet ? `${pet}'s tribute is still here, whenever you're ready`
           : `Your tribute is still here, whenever you're ready`)
    : (pet ? `${pet}'s tribute is ready for your eyes`
           : `Your tribute is ready for your eyes`);

  return send(to, subject, html);
}

/**
 * Ask David/Rebecca to review a freshly generated proof before it goes to
 * the customer. This is the review gate: the ONLY path to the customer
 * proof email runs through the /admin/review page this email links to.
 * ADMIN_EMAIL may be a comma-separated list (David + Rebecca).
 */
async function sendReviewRequest(order, { reviewUrl, proofImageUrl, partnerName = null, isGift = false }) {
  if (!ADMIN_EMAIL) {
    console.warn(`Email: ADMIN_EMAIL not configured — order ${order.id} is waiting in review with no notification. Set ADMIN_EMAIL.`);
    return;
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const shortId = order.id.substring(0, 8).toUpperCase();
  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};

  const FIELD_LABELS = {
    petName: 'Pet name',
    petNicknames: 'Nicknames',
    petType: 'Type',
    breed: 'Breed',
    birthDate: 'Born',
    passDate: 'Passed',
    personality: 'Personality',
    favoriteMemory: 'Favorite memory',
    favoriteThing: 'Favorite thing',
    familyName: 'Family',
    name: 'Name',
    giftNote: 'Gift note (printed & enclosed)',
    giftFrom: 'Gift note signed',
  };
  const answerRows = Object.entries(FIELD_LABELS)
    .filter(([key]) => fields[key])
    .map(([key, label]) => `
      <tr>
        <td style="padding:6px 12px 6px 0;color:#6b6359;font-weight:600;vertical-align:top;white-space:nowrap;">${label}</td>
        <td style="padding:6px 0;color:#2C2C2C;">${esc(fields[key])}</td>
      </tr>`)
    .join('');

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;">
      <h1 style="font-family:Georgia,serif;font-size:1.4rem;font-weight:400;color:#2C2C2C;margin:0 0 4px;">
        Review needed &mdash; Order ${shortId}
      </h1>
      <p style="color:#9B9590;margin:0 0 20px;">
        ${esc(order.email || 'No email')} &middot; ${isGift
          ? `free keepsake, a gift from ${esc(partnerName || 'a partner')}`
          : `${formatPrice(order.total_cents)} &middot; paid`}${partnerName && !isGift
          ? ` &middot; sent by ${esc(partnerName)}` : ''} &middot; waiting on your approval
      </p>

      ${proofImageUrl ? `
      <div style="text-align:center;margin:0 0 20px;">
        <img src="${proofImageUrl}" alt="Proof awaiting review" style="max-width:100%;border-radius:8px;border:1px solid #E8E4DF;" />
      </div>` : ''}

      <div style="background:#FAF8F5;border-radius:8px;padding:16px;margin:0 0 16px;border-left:3px solid #C4A882;">
        <strong>Poem as the customer approved it at checkout:</strong>
        <div style="font-family:Georgia,serif;white-space:pre-wrap;line-height:1.6;margin-top:8px;">${esc(order.poem_text || '(no poem on order)')}</div>
      </div>

      <table style="border-collapse:collapse;font-size:0.9rem;margin:0 0 20px;">${answerRows}</table>

      <div style="text-align:center;margin:24px 0 8px;">
        <a href="${reviewUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          Review &amp; approve proof
        </a>
      </div>
      <p style="text-align:center;color:#9B9590;font-size:0.8rem;">
        ${isGift
          ? 'The family approved this proof. Approving here emails them their keepsake (screen size, not the print file).'
          : 'The customer already approved this proof before paying. Nothing goes to the printer until you approve it here.'}
      </p>
    </div>
  `);

  const petName = fields.petName || fields.name || '';
  const kind = isGift ? 'Gift keepsake' : 'Order';
  return send(ADMIN_EMAIL, `Review needed — ${kind} ${shortId}${petName ? ` (${petName})` : ''}`, html);
}

/**
 * Notify admin when a customer requests changes to their proof.
 */
async function sendChangeRequestNotification(orderData, notes, reviewUrl) {
  if (!ADMIN_EMAIL) {
    console.warn('Email: ADMIN_EMAIL not configured — change request notification skipped');
    return;
  }

  const { orderId, email, templateName } = orderData;
  const shortId = orderId.substring(0, 8).toUpperCase();

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;">
      <h1 style="font-family:Georgia,serif;font-size:1.4rem;font-weight:400;color:#2C2C2C;margin:0 0 16px;">
        Change request — Order ${shortId}
      </h1>
      <p style="color:#2C2C2C;line-height:1.6;">
        <strong>Customer:</strong> ${email || 'N/A'}<br>
        <strong>Template:</strong> ${templateName || 'N/A'}<br>
        <strong>Order ID:</strong> ${orderId}
      </p>
      <div style="background:#FAF8F5;border-radius:8px;padding:16px;margin:16px 0;border-left:3px solid #C4A882;">
        <strong>Customer notes:</strong><br>
        ${(notes || 'No details provided').replace(/\n/g, '<br>')}
      </div>
      ${reviewUrl ? `
      <div style="text-align:center;margin:24px 0 8px;">
        <a href="${reviewUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          Edit poem &amp; resend proof
        </a>
      </div>` : `
      <p style="color:#9B9590;font-size:0.85rem;">
        Open the review link from the original order email to regenerate the proof.
      </p>`}
    </div>
  `);

  return send(ADMIN_EMAIL, `Change request — Order ${shortId}`, html);
}

/**
 * How a customer email names the physical piece. Every one of these emails was
 * written when the only thing we shipped was a framed tribute, and the first
 * print-only customer (2A47ADF9) was told their "framed tribute" had shipped
 * when we sent them bare paper for their own frame. The SKU decides the words,
 * by the same rule Luma ordering uses, so the email and the parcel agree.
 */
function describePiece(sku) {
  const { isPrintOnlySku } = require('./lumaOrderApi');
  return isPrintOnlySku(sku)
    ? { noun: 'tribute print', boxed: 'print', making: 'printed on archival fine art paper, ready for a frame of your choosing' }
    : { noun: 'framed tribute', boxed: 'frame', making: 'printed on archival paper and professionally framed' };
}

/**
 * Send confirmation to customer that their proof was approved and order is printing.
 * When noteCardUrl is given (framed orders — the insert card rendered at release),
 * the email shows the exact note that will be tucked in the box, so the buyer
 * knows what the recipient will find alongside the frame.
 */
async function sendApprovalConfirmation(to, orderData, statusPageUrl, noteCardUrl = null) {
  const { orderId, totalCents, sku } = orderData;
  const shortId = orderId.substring(0, 8).toUpperCase();
  const piece = describePiece(sku);

  const noteCardBlock = noteCardUrl ? `
      <div style="margin-top:28px;text-align:left;">
        <p style="color:#2C2C2C;line-height:1.6;margin:0 0 12px;">
          Tucked in the box with the ${piece.boxed} is this note, printed on cream paper:
        </p>
        <img src="${noteCardUrl}" alt="The note enclosed with your ${piece.noun}"
             style="display:block;width:100%;max-width:420px;margin:0 auto;border:1px solid #E8E4DF;border-radius:8px;">
      </div>
  ` : '';

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;text-align:center;">
      <div style="font-size:2.5rem;margin-bottom:12px;">&#10003;</div>
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;margin:0 0 8px;">
        Your tribute is being printed
      </h1>
      <p style="color:#9B9590;margin:0 0 24px;">
        Order ${shortId} &middot; ${formatPrice(totalCents)}
      </p>
      <p style="color:#2C2C2C;line-height:1.6;text-align:left;">
        The design you approved has passed its final review and is now being ${piece.making}.
        You'll receive tracking information by email once it ships.
      </p>
      ${noteCardBlock}
      <p style="color:#9B9590;font-size:0.9rem;margin-top:24px;">
        Estimated delivery: 8&ndash;12 business days
      </p>
      ${statusPageUrl ? `
      <p style="margin-top:24px;">
        <a href="${statusPageUrl}"
           style="display:inline-block;background:transparent;color:#8B9D83;text-decoration:none;padding:10px 24px;border:1px solid #8B9D83;border-radius:8px;font-weight:600;font-size:0.9rem;">
          View order status
        </a>
      </p>` : ''}
    </div>
  `);

  return send(to, `Your tribute is printing: Order ${shortId}`, html);
}

/**
 * Digital Keepsake delivery — the customer's finished tribute as a printable
 * high-resolution file, plus a credit toward the framed piece.
 *
 * Reached only from the admin review approve action for fulfillment:"digital"
 * orders (adminReview.js). There is NO auto-send path: a real person reviews
 * every order before this goes out, and the copy says so. Brand voice: kind,
 * short sentences, en dashes with spaces (never em dashes), no exclamation
 * points.
 *
 * @param {string} to
 * @param {object} orderData — { orderId, totalCents }
 * @param {object} links — { downloadUrl, promoCode?, upgradeUrl?, statusPageUrl? }
 */
async function sendDigitalDeliveryEmail(to, orderData, links = {}) {
  const { orderId, totalCents } = orderData;
  const { downloadUrl, promoCode, upgradeUrl, statusPageUrl } = links;
  const shortId = orderId.substring(0, 8).toUpperCase();

  const creditBlock = promoCode ? `
      <div style="background:#FAF8F5;border-radius:8px;padding:20px;margin:24px 0 0;border-left:3px solid #C4A882;">
        <p style="color:#2C2C2C;line-height:1.6;margin:0 0 8px;">
          Want it on the wall in a frame? Put this ${formatPrice(1995)} toward the framed tribute
          within 30 days.
        </p>
        <p style="color:#2C2C2C;line-height:1.6;margin:0 0 12px;">
          Use code <strong style="font-family:Georgia,serif;letter-spacing:0.5px;">${promoCode}</strong> at checkout.
        </p>
        ${upgradeUrl ? `
        <a href="${upgradeUrl}" style="color:#8B9D83;font-weight:600;text-decoration:none;">
          Design the framed tribute &rarr;
        </a>` : ''}
      </div>` : '';

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;margin-bottom:24px;">
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;text-align:center;margin:0 0 8px;">
        Their tribute is ready
      </h1>
      <p style="text-align:center;color:#9B9590;margin:0 0 24px;">
        Order ${shortId} &middot; ${formatPrice(totalCents)}
      </p>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:16px;">
        A real person reviewed every word, and your keepsake is ready to download. This is the
        same high-resolution file a print shop would use &ndash; exactly the tribute you approved.
      </p>

      <div style="text-align:center;margin:24px 0 16px;">
        <a href="${downloadUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          Download your tribute
        </a>
      </div>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:8px;">
        It prints beautifully up to 11&times;14 at any print shop or home printer. Save the file
        somewhere safe &ndash; the download link stays active for 90 days.
      </p>

      ${creditBlock}
      ${statusPageUrl ? `
      <p style="text-align:center;color:#9B9590;font-size:0.85rem;margin-top:24px;">
        You can <a href="${statusPageUrl}" style="color:#8B9D83;">view your order</a> anytime.
      </p>` : ''}
    </div>
  `);

  return send(to, `Their tribute is ready – Order ${shortId}`, html);
}

/**
 * A partner gift keepsake was placed: tell the family we have it.
 *
 * Nothing about money (there was none) and no order number up top: this
 * person did not buy anything, a practice they trust gave them something. It
 * says who, says a person reads it before it comes, and leaves room to fix a
 * date or a spelling.
 *
 * @param {string} to
 * @param {object} d — { orderId, petName, partnerName }
 * @param {string} statusPageUrl
 */
async function sendGiftKeepsakeReceived(to, d, statusPageUrl) {
  const pet = escapeHtml(d.petName || '');
  const partner = escapeHtml(d.partnerName || '');
  const whose = pet ? `${pet}’s tribute` : 'your tribute';

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;margin-bottom:24px;">
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;text-align:center;margin:0 0 8px;">
        We have ${whose}
      </h1>
      ${partner ? `
      <p style="text-align:center;color:#9B9590;margin:0 0 24px;">A gift from ${partner}</p>` : ''}

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:16px;">
        ${partner ? `${partner} asked us to make this for you, and there is nothing to pay.` : 'This keepsake is a gift, and there is nothing to pay.'}
        Before it comes to you, someone here reads every word and looks over the photo.
        It is usually in your inbox within a day or two.
      </p>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:24px;">
        If you want to change anything in the meantime, a date, a spelling, a word in the poem,
        just reply to this email.
      </p>

      <div style="text-align:center;margin-bottom:8px;">
        <a href="${statusPageUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          See where it is
        </a>
      </div>
    </div>
  `);

  return send(to, pet ? `We have ${d.petName}’s tribute` : 'We have your tribute', html);
}

/**
 * The partner gift keepsake is ready.
 *
 * The file is screen size: for a phone, a computer, or sending to family. The
 * print-quality file only comes with a framed order, and the framed order is
 * one tap away from their own saved design, so this is the one honest place
 * to mention it, once, quietly, after the gift itself.
 *
 * @param {string} to
 * @param {object} d — { orderId, petName, partnerName, framedFromCents }
 * @param {object} links — { downloadUrl, frameUrl, statusPageUrl }
 */
async function sendGiftKeepsakeDelivery(to, d, links = {}) {
  const pet = escapeHtml(d.petName || '');
  const partner = escapeHtml(d.partnerName || '');
  const { downloadUrl, frameUrl, statusPageUrl } = links;
  const whose = pet ? `${pet}’s tribute` : 'Your tribute';

  const frameBlock = frameUrl ? `
      <div style="background:#FAF8F5;border-radius:8px;padding:20px;margin:24px 0 0;border-left:3px solid #C4A882;">
        <p style="color:#2C2C2C;line-height:1.6;margin:0 0 12px;">
          If you would like it on the wall, we print it on archival paper and frame it,
          ${d.framedFromCents ? `from ${formatPrice(d.framedFromCents)}, ` : ''}with free shipping.
          Your design is saved, so it opens just as you left it.
        </p>
        <a href="${frameUrl}" style="color:#8B9D83;font-weight:600;text-decoration:none;">
          Have it framed &rarr;
        </a>
      </div>` : '';

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;margin-bottom:24px;">
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;text-align:center;margin:0 0 8px;">
        ${whose} is ready
      </h1>
      ${partner ? `
      <p style="text-align:center;color:#9B9590;margin:0 0 24px;">A gift from ${partner}</p>` : ''}

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:16px;">
        Here it is. It is sized for your phone and computer, so you can keep it close
        or send it to the people who knew ${pet || 'them'} too.
      </p>

      <div style="text-align:center;margin:24px 0 16px;">
        <a href="${downloadUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          Download ${pet ? `${pet}’s tribute` : 'your tribute'}
        </a>
      </div>

      <p style="color:#9B9590;font-size:0.85rem;line-height:1.6;margin-bottom:8px;text-align:center;">
        The download link stays active for 90 days, so save it somewhere safe.
      </p>

      ${frameBlock}
      ${statusPageUrl ? `
      <p style="text-align:center;color:#9B9590;font-size:0.85rem;margin-top:24px;">
        You can <a href="${statusPageUrl}" style="color:#8B9D83;">see your keepsake</a> anytime.
      </p>` : ''}
    </div>
  `);

  return send(to, pet ? `${d.petName}’s tribute is ready` : 'Your tribute is ready', html);
}

/**
 * Email a new order to the partner print shop.
 * Includes the print file (attached when under 20MB, always linked),
 * order specs, shipping address, and a tokenized admin link for
 * marking the order shipped.
 */
async function sendPartnerOrderEmail(order, { printFileUrl, printFilePath, adminUrl, proofImageUrl }) {
  const partnerEmail = process.env.PARTNER_PRINT_EMAIL;
  if (!partnerEmail) {
    throw new Error('PARTNER_PRINT_EMAIL not configured');
  }

  const fs = require('fs');
  const sid = order.id.substring(0, 8).toUpperCase();
  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};
  const shipping = order.shipping_json ? JSON.parse(order.shipping_json) : {};
  const colors = fields.colors || null;
  const sizeMatch = (order.product_sku || '').match(/(\d+)x(\d+)/);
  const sizeLabel = sizeMatch ? `${sizeMatch[1]}×${sizeMatch[2]}"` : order.product_sku;
  const orientation = fields.layout === 'stacked' ? 'Portrait' : 'Landscape';

  // Attach the print file only when it's a sane email size; the link always works
  const attachments = [];
  try {
    if (printFilePath && fs.existsSync(printFilePath) && fs.statSync(printFilePath).size < 20 * 1024 * 1024) {
      attachments.push({ filename: `${sid}-print-ready.jpg`, path: printFilePath });
    }
  } catch (e) {
    // Attachment is best-effort; the download link is the source of truth
  }

  const colorChips = colors ? `
      <p style="color:#2C2C2C;line-height:1.8;margin:0 0 16px;">
        <strong>Printed mat:</strong> <span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${colors.mat};vertical-align:middle;border:1px solid #ccc;"></span> ${colors.mat}
        &nbsp;&nbsp;<strong>Bevel accent:</strong> <span style="display:inline-block;width:14px;height:14px;border-radius:3px;background:${colors.bevel};vertical-align:middle;border:1px solid #ccc;"></span> ${colors.bevel}
      </p>` : '';

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;">
      <h1 style="font-family:Georgia,serif;font-size:1.4rem;font-weight:400;color:#2C2C2C;margin:0 0 16px;">
        New print order — ${sid}
      </h1>

      <p style="color:#2C2C2C;line-height:1.8;margin:0 0 16px;">
        <strong>Product:</strong> ${sizeLabel} framed tribute, archival print (border + bevel printed in-image, full bleed)<br>
        <strong>Orientation:</strong> ${orientation}<br>
        <strong>Print file:</strong> 300 DPI JPEG${attachments.length ? ' (attached)' : ''} — <a href="${printFileUrl}" style="color:#8B9D83;">download</a>
      </p>
      ${colorChips}

      <div style="background:#FAF8F5;border-radius:8px;padding:16px;margin:16px 0;">
        <strong>Ship to:</strong><br>
        ${shipping.name || ''}<br>
        ${shipping.address1 || ''}${shipping.address2 ? '<br>' + shipping.address2 : ''}<br>
        ${shipping.city || ''}, ${shipping.state || ''} ${shipping.zip || ''}<br>
        ${shipping.country || 'US'}
      </div>

      ${proofImageUrl ? `
      <p style="color:#9B9590;font-size:0.85rem;margin:16px 0;">
        Customer-approved proof: <a href="${proofImageUrl}" style="color:#8B9D83;">view</a>
      </p>` : ''}

      <div style="text-align:center;margin:24px 0 8px;">
        <a href="${adminUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          Mark shipped / add tracking
        </a>
      </div>
      <p style="text-align:center;color:#9B9590;font-size:0.8rem;">
        When the piece ships, open this link and enter the tracking number — the customer is notified automatically.
      </p>
    </div>
  `);

  const cc = ADMIN_EMAIL && ADMIN_EMAIL !== partnerEmail ? { cc: ADMIN_EMAIL } : {};
  return send(partnerEmail, `New print order — ${sid} (${sizeLabel} ${orientation})`, html, { attachments, ...cc });
}

/**
 * Notify the customer their tribute has shipped, with tracking.
 */
async function sendShippedEmail(to, orderData, tracking, statusPageUrl) {
  const { orderId, sku } = orderData;
  const sid = orderId.substring(0, 8).toUpperCase();
  const piece = describePiece(sku);
  const trackingLine = tracking && tracking.number
    ? `<p style="color:#2C2C2C;line-height:1.6;text-align:center;margin:16px 0;">
         <strong>Tracking:</strong> ${tracking.url
           ? `<a href="${tracking.url}" style="color:#8B9D83;">${tracking.number}</a>`
           : tracking.number}${tracking.carrier ? ` (${tracking.carrier})` : ''}
       </p>`
    : '';

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;text-align:center;">
      <div style="font-size:2.5rem;margin-bottom:12px;">&#128230;</div>
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;margin:0 0 8px;">
        Their tribute is on its way
      </h1>
      <p style="color:#9B9590;margin:0 0 24px;">Order ${sid}</p>
      <p style="color:#2C2C2C;line-height:1.6;">
        Your ${piece.noun} has shipped. We hope it brings you comfort every time you see it.
      </p>
      ${trackingLine}
      ${statusPageUrl ? `
      <p style="margin-top:24px;">
        <a href="${statusPageUrl}"
           style="display:inline-block;background:transparent;color:#8B9D83;text-decoration:none;padding:10px 24px;border:1px solid #8B9D83;border-radius:8px;font-weight:600;font-size:0.9rem;">
          Track your order
        </a>
      </p>` : ''}
    </div>
  `);

  return send(to, `Your tribute has shipped: Order ${sid}`, html);
}

/**
 * Ask the customer, some days after their piece shipped, how it turned out.
 *
 * NOT to be confused with sendReviewRequest above, which despite its name goes
 * to David and Rebecca about a proof awaiting approval. This one is the only
 * email in the system that goes to a customer about reviewing their piece.
 *
 * Someone is being asked about an object that commemorates an animal that
 * died, so this reads as a person asking rather than a form arriving. The two
 * questions it previews are the two the page actually asks: how the whole thing
 * went, and what they thought when they opened it.
 *
 * It does not ask anyone to rate the poem. Scoring a piece of writing about
 * your own dead pet is an awkward and faintly absurd request, and it is the
 * reason no ratings were collected here for three years. What a customer can
 * fairly judge is the order: the print, the frame, the delivery, the proof
 * round, whether anyone answered them. That is what the stars are for.
 *
 * No deadline, no reminder, no second ask, and a plain reply is offered as an
 * equal alternative to the form.
 *
 * @param {string} to customer email
 * @param {object} orderData { orderId, petName }
 * @param {string} reviewUrl the customer's /review/:token page
 */
async function sendReviewInvite(to, orderData, reviewUrl) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const pet = orderData && orderData.petName ? String(orderData.petName).trim() : '';
  const safePet = esc(pet);
  const possessive = safePet ? `${safePet}'s` : 'your';

  const heading = safePet
    ? `Did ${safePet}'s piece arrive safely?`
    : `Did your piece arrive safely?`;

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;margin-bottom:24px;">
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;text-align:center;margin:0 0 24px;">
        ${heading}
      </h1>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:16px;">
        ${possessive.charAt(0).toUpperCase() + possessive.slice(1)} piece left us a little while ago,
        so by now it should be somewhere you can see it.
      </p>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:16px;">
        Would you leave us a review? There are two things we would like to know: how the whole
        thing went, from ordering it to hanging it up, and what you thought when you opened it.
      </p>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:24px;">
        And one favour, which matters to us more than the stars. If you can, take a photo of it
        where it hangs and send it with your review. The next family deciding whether to trust us
        with their own animal will believe a real frame on a real wall long before they believe
        anything we say about ourselves.
      </p>

      <div style="text-align:center;margin-bottom:24px;">
        <a href="${reviewUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          Leave a review
        </a>
      </div>

      <div style="background:#FAF7F2;border:1px solid #E8E4DF;border-radius:8px;padding:20px;">
        <p style="color:#2C2C2C;line-height:1.7;margin:0;">
          It takes a minute or two. We are not asking you to grade the poem, only the order around
          it: the print, the frame, and how we were to deal with. Nothing you write or send goes on
          our website unless you tick the box that says it may. If something is not right, that
          link reaches us, and so does a plain reply to this email.
        </p>
      </div>
    </div>
  `);

  const subject = pet
    ? `Did ${pet}'s piece arrive safely?`
    : `Did your piece arrive safely?`;

  return send(to, subject, html);
}

/**
 * Tell the shop a customer has left a review.
 *
 * The third "review" email in this file, and the only one that reports rather
 * than asks: sendReviewRequest asks the shop to approve a proof,
 * sendReviewInvite asks a buyer how their piece turned out, and this one says
 * the buyer has answered. It goes to ADMIN_EMAIL and nowhere else. The
 * customer is never a recipient, so no review can cause mail to a family.
 *
 * A review waits as 'pending' until someone publishes or hides it, and before
 * this existed nothing said one had arrived. That matters most for a low
 * rating, which is a person with a problem and deserves a reply the same day.
 *
 * @param {object} order      the orders row the review belongs to
 * @param {object} review     { rating, body, authorDisplay, consentToPublish }
 * @param {string} [photoFile] absolute path of the stored photo, attached if given
 */
async function sendReviewReceived(order, review, photoFile) {
  if (!ADMIN_EMAIL) {
    console.warn(`Email: ADMIN_EMAIL not configured — a review for order ${order.id} is waiting with no notification. Set ADMIN_EMAIL.`);
    return { skipped: true };
  }

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const shortId = order.id.substring(0, 8).toUpperCase();
  let fields = {};
  try { fields = order.fields_json ? JSON.parse(order.fields_json) : {}; } catch (err) { /* alert still goes */ }
  const petName = String(fields.petName || fields.name || '').trim();

  const rating = Number(review.rating);
  const stars = `${rating} star${rating === 1 ? '' : 's'}`;
  const isLow = rating <= 3;

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;">
      <h1 style="font-family:Georgia,serif;font-size:1.4rem;font-weight:400;color:#2C2C2C;margin:0 0 4px;">
        New review: ${stars}${petName ? ` for ${esc(petName)}` : ''}
      </h1>
      <p style="color:#9B9590;margin:0 0 20px;">
        ${esc(order.email || 'No email')} &middot; Order ${shortId}
      </p>

      <p style="font-size:1.5rem;letter-spacing:3px;color:#C4A882;margin:0 0 16px;">
        ${'&#9733;'.repeat(rating)}<span style="color:#E8E4DF;">${'&#9733;'.repeat(5 - rating)}</span>
      </p>

      ${isLow ? `
      <p style="color:#2C2C2C;line-height:1.6;background:#FBF3EE;border-left:3px solid #B5651D;border-radius:8px;padding:12px 16px;margin:0 0 16px;">
        This is a low rating. A personal reply to the customer comes before anything else.
      </p>` : ''}

      <div style="background:#FAF8F5;border-radius:8px;padding:16px;margin:0 0 16px;border-left:3px solid #C4A882;">
        <div style="font-family:Georgia,serif;white-space:pre-wrap;line-height:1.6;color:#2C2C2C;">${review.body ? esc(review.body) : '<span style="color:#9B9590;">They left a rating without any words.</span>'}</div>
      </div>

      <table style="border-collapse:collapse;font-size:0.9rem;margin:0 0 20px;">
        <tr>
          <td style="padding:6px 12px 6px 0;color:#6b6359;font-weight:600;white-space:nowrap;">Signed as</td>
          <td style="padding:6px 0;color:#2C2C2C;">${review.authorDisplay ? esc(review.authorDisplay) : 'No name given'}</td>
        </tr>
        <tr>
          <td style="padding:6px 12px 6px 0;color:#6b6359;font-weight:600;white-space:nowrap;">May be published</td>
          <td style="padding:6px 0;color:#2C2C2C;">${review.consentToPublish ? 'Yes, they ticked the box' : 'No. For your eyes only'}</td>
        </tr>
        <tr>
          <td style="padding:6px 12px 6px 0;color:#6b6359;font-weight:600;white-space:nowrap;">Photo</td>
          <td style="padding:6px 0;color:#2C2C2C;">${photoFile ? 'Attached to this email' : 'None sent'}</td>
        </tr>
      </table>

      <div style="text-align:center;margin:24px 0 8px;">
        <a href="${BASE_URL}/admin/orders#reviews"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          Open the review queue
        </a>
      </div>
      <p style="text-align:center;color:#9B9590;font-size:0.8rem;">
        Nothing appears on the website until you publish it there.
      </p>
    </div>
  `);

  const extra = photoFile
    ? { attachments: [{ filename: `review-${shortId}.jpg`, path: photoFile }] }
    : {};

  return send(ADMIN_EMAIL, `New review: ${stars}${petName ? ` for ${petName}` : ''} (${shortId})`, html, extra);
}

/**
 * Deliver the poems someone asked for by email.
 *
 * The exchange on the poem pages is the poems themselves, never a discount, so
 * this email owes the reader exactly what was promised and nothing else. It
 * carries no offer, no product pitch and no urgency. The poems live on pages
 * that are free to read without an address, which is deliberate: the email is
 * a convenience for someone who wants them to hand, not a toll gate.
 *
 * @param {string} to subscriber email
 */
async function sendPoemPack(to) {
  const link = (path, label, note) => `
    <p style="color:#2C2C2C;line-height:1.6;margin:0 0 16px;">
      <a href="${BASE_URL}${path}" style="color:#8B9D83;font-weight:600;text-decoration:none;">${label}</a><br>
      <span style="color:#9B9590;font-size:0.95rem;">${note}</span>
    </p>`;

  const html = wrapHtml(`
    <div style="background:#fff;border-radius:12px;padding:32px;margin-bottom:24px;">
      <h1 style="font-family:Georgia,serif;font-size:1.6rem;font-weight:400;color:#2C2C2C;text-align:center;margin:0 0 24px;">
        The poems, as promised
      </h1>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:24px;">
        Here they are. You can read them on the page, print them, or copy the words
        straight into a card.
      </p>

      ${link('/rainbow-bridge-poem-for-dogs', 'Five rainbow bridge poems for dogs', 'Plus where the original poem came from, and who wrote it.')}
      ${link('/rainbow-bridge-poem-for-cats', 'Five rainbow bridge poems for cats', 'Written for cats specifically, not adapted from the dog versions.')}
      ${link('/blog/pet-memorial-poems', 'The wider collection of pet memorial poems', 'Shorter verses for cards, and longer ones for reading aloud.')}

      <div style="background:#FAF7F2;border:1px solid #E8E4DF;border-radius:8px;padding:20px;margin-top:8px;">
        <p style="color:#2C2C2C;line-height:1.7;margin:0;">
          These were written by us and they are free to print, read aloud, or copy into a card.
          Please do not resell them as your own. If you want to read one at a burial or a
          scattering, you have our blessing and you need no permission from anyone.
        </p>
      </div>
    </div>
  `);

  return send(to, 'The poems, as promised', html);
}

module.exports = {
  // Low-level shell + dispatcher, reused by src/services/vaultEmails.js so the
  // Story Vault occasion emails share this brand wrapper and SMTP fallback.
  wrapHtml,
  send,
  sendAdminAlert,
  sendOrderConfirmation,
  sendAbandonedCheckoutRecovery,
  sendDesignSaved,
  sendDesignReminder,
  sendProofEmail,
  sendProofReminder,
  sendReviewRequest,
  sendChangeRequestNotification,
  sendApprovalConfirmation,
  sendDigitalDeliveryEmail,
  sendGiftKeepsakeReceived,
  sendGiftKeepsakeDelivery,
  sendPartnerOrderEmail,
  sendShippedEmail,
  describePiece,
  // Customer-facing. sendReviewInvite is the one that asks a BUYER about their
  // piece; sendReviewRequest above asks the SHOP to approve a proof.
  sendReviewInvite,
  // Shop-facing: the buyer answered. Never addressed to a customer.
  sendReviewReceived,
  sendPoemPack,
};
