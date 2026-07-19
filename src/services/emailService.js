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
  const { from, to, subject, html, text, cc, attachments } = mailOptions;

  const payload = { from, to: splitAddresses(to), subject };
  if (html) payload.html = html;
  if (text) payload.text = text;
  if (cc) payload.cc = splitAddresses(cc);
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

async function send(to, subject, html, extra = {}) {
  return deliver({ from: FROM, to, subject, html, ...extra });
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
        Your payment was received successfully, and we've started designing your tribute.
        Within the next few hours, you'll receive a second email with your design proof to review and approve.
      </p>

      <p style="color:#2C2C2C;line-height:1.6;margin-bottom:24px;">
        Nothing goes to print until you've approved how it looks &mdash; so take your time when the proof arrives.
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
        The customer does not see their proof until you approve it here.
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
 */
async function sendApprovalConfirmation(to, orderData, statusPageUrl) {
  const { orderId, totalCents } = orderData;
  const shortId = orderId.substring(0, 8).toUpperCase();

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
        Your proof has been approved and your tribute is now being printed on archival paper
        and professionally framed. You'll receive tracking information by email once it ships.
      </p>
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

module.exports = {
  // Low-level shell + dispatcher, reused by src/services/vaultEmails.js so the
  // Story Vault occasion emails share this brand wrapper and SMTP fallback.
  wrapHtml,
  send,
  sendAdminAlert,
  sendOrderConfirmation,
  sendProofEmail,
  sendReviewRequest,
  sendChangeRequestNotification,
  sendApprovalConfirmation,
  sendDigitalDeliveryEmail,
  sendPartnerOrderEmail,
  sendShippedEmail,
};
