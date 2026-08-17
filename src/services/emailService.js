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
 * @param {string} resumeUrl — absolute link back to the customizer for this
 *        order's template (the customizer restores an in-progress design from
 *        the browser session, so it's an honest "pick it back up").
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
    ? `You started a tribute for ${safePet}, and it's still here for you. There's no rush at all &mdash; take all the time you need.`
    : `You started a tribute, and it's still here for you. There's no rush at all &mdash; take all the time you need.`;

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

      <div style="background:#FAF7F2;border:1px solid #E8E4DF;border-radius:8px;padding:20px;">
        <p style="color:#2C2C2C;line-height:1.6;margin:0 0 8px;font-weight:600;">
          A few things to set your mind at ease:
        </p>
        <ul style="color:#2C2C2C;line-height:1.7;margin:0;padding-left:20px;">
          <li>You'll see the finished proof before you pay &mdash; nothing is printed until you've read every word and said it's right.</li>
          <li>You can ask for a full refund any time before it goes to print &mdash; no questions asked.</li>
          <li>Shipping within the US is always free.</li>
        </ul>
      </div>
    </div>
  `);

  const subject = petName
    ? `${petName}'s tribute is here whenever you're ready`
    : `Your tribute is here whenever you're ready`;

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
        it will be printed on archival paper and professionally framed.
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
async function sendReviewRequest(order, { reviewUrl, proofImageUrl }) {
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
        ${esc(order.email || 'No email')} &middot; ${formatPrice(order.total_cents)} &middot; paid, waiting on your approval
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
        The customer already approved this proof before paying. Nothing goes to
        the printer until you approve it here.
      </p>
    </div>
  `);

  const petName = fields.petName || fields.name || '';
  return send(ADMIN_EMAIL, `Review needed — Order ${shortId}${petName ? ` (${petName})` : ''}`, html);
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
 * Send confirmation to customer that their proof was approved and order is printing.
 * When noteCardUrl is given (framed orders — the insert card rendered at release),
 * the email shows the exact note that will be tucked in the box, so the buyer
 * knows what the recipient will find alongside the frame.
 */
async function sendApprovalConfirmation(to, orderData, statusPageUrl, noteCardUrl = null) {
  const { orderId, totalCents } = orderData;
  const shortId = orderId.substring(0, 8).toUpperCase();

  const noteCardBlock = noteCardUrl ? `
      <div style="margin-top:28px;text-align:left;">
        <p style="color:#2C2C2C;line-height:1.6;margin:0 0 12px;">
          Tucked in the box with the frame is this note, printed on cream paper:
        </p>
        <img src="${noteCardUrl}" alt="The note enclosed with your framed tribute"
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
        The design you approved has passed its final review and is now being printed on archival
        paper and professionally framed. You'll receive tracking information by email once it ships.
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

  return send(to, `Your tribute is printing — Order ${shortId}`, html);
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
  const { orderId } = orderData;
  const sid = orderId.substring(0, 8).toUpperCase();
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
        Your framed tribute has shipped. We hope it brings you comfort every time you see it.
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

  return send(to, `Your tribute has shipped — Order ${sid}`, html);
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

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:24px;">
        There are two things we would like to know, if you have a moment. How the whole thing went,
        from ordering it to hanging it up, and what you thought when you opened it.
      </p>

      <div style="text-align:center;margin-bottom:24px;">
        <a href="${reviewUrl}"
           style="display:inline-block;background:#8B9D83;color:#fff;text-decoration:none;padding:14px 40px;border-radius:8px;font-weight:600;font-size:1rem;">
          Tell us how it turned out
        </a>
      </div>

      <div style="background:#FAF7F2;border:1px solid #E8E4DF;border-radius:8px;padding:20px;">
        <p style="color:#2C2C2C;line-height:1.7;margin:0;">
          It takes a minute. We are not asking you to grade the poem, only the order around it:
          the print, the frame, and how we were to deal with. Nothing you write goes on our website
          unless you tell us it may. If something is not right, that link reaches us, and so does a
          plain reply to this email.
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
  sendProofEmail,
  sendProofReminder,
  sendReviewRequest,
  sendChangeRequestNotification,
  sendApprovalConfirmation,
  sendDigitalDeliveryEmail,
  sendPartnerOrderEmail,
  sendShippedEmail,
  // Customer-facing. sendReviewInvite is the one that asks a BUYER about their
  // piece; sendReviewRequest above asks the SHOP to approve a proof.
  sendReviewInvite,
  sendPoemPack,
};
