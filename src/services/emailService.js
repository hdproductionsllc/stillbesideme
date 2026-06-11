/**
 * Email Service – thin Nodemailer wrapper for proof workflow emails.
 * Works with any SMTP provider (Resend, SendGrid, Gmail, Mailtrap, etc).
 */

const nodemailer = require('nodemailer');

const FROM = process.env.EMAIL_FROM || 'Still Beside Me <hello@stillbesideme.com>';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || '';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;

  if (!process.env.SMTP_HOST) {
    console.warn('Email: SMTP_HOST not configured — emails will be logged but not sent');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
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
  const t = getTransporter();
  const mailOptions = { from: FROM, to, subject, html, ...extra };

  if (!t) {
    console.log(`Email (not sent — no SMTP): to=${to} subject="${subject}"`);
    return { preview: true };
  }

  const result = await t.sendMail(mailOptions);
  console.log(`Email sent: to=${to} subject="${subject}" messageId=${result.messageId}`);
  return result;
}

/**
 * Send an order-confirmation email immediately after Stripe webhook fires.
 * This goes out within seconds of payment, before the proof is generated,
 * so the customer is reassured that we received their order.
 */
async function sendOrderConfirmation(to, orderData, statusPageUrl) {
  const { orderId, templateName, sku, totalCents } = orderData;
  const shortId = orderId.substring(0, 8).toUpperCase();

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
 * Notify admin when a customer requests changes to their proof.
 */
async function sendChangeRequestNotification(orderData, notes) {
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
      <p style="color:#9B9590;font-size:0.85rem;">
        Log in to the admin dashboard to review and regenerate the proof.
      </p>
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
        Estimated delivery: 5&ndash;10 business days
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
 * Email a new order to the partner UV print shop.
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
        New UV print order — ${sid}
      </h1>

      <p style="color:#2C2C2C;line-height:1.8;margin:0 0 16px;">
        <strong>Product:</strong> ${sizeLabel} framed tribute, UV-printed (mat + bevel printed in-image, full bleed)<br>
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
  return send(partnerEmail, `New UV print order — ${sid} (${sizeLabel} ${orientation})`, html, { attachments, ...cc });
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
  sendOrderConfirmation,
  sendProofEmail,
  sendChangeRequestNotification,
  sendApprovalConfirmation,
  sendPartnerOrderEmail,
  sendShippedEmail,
};
