/**
 * Insert Card Renderer — the card in every box.
 *
 * Every physical order encloses exactly one card (Luma's `printouts` — free,
 * up to 3 publicly-fetchable URLs printed and enclosed); only the words change:
 *
 *   personal-note — gift order, sender wrote a message. Their words, signed.
 *   gift-card     — gift order, no message. A warm line from the (required)
 *                   sender name, so the box is never anonymous.
 *   thank-you     — self purchase. A thank-you with a care line.
 *
 * A4 is Luma's constraint, not a choice: we don't control the stock or the fold.
 * So the design leans on what we DO control — the cream paper palette and the
 * Cormorant of the tribute itself — so the sheet reads as a letter that belongs
 * with the frame rather than a packing slip that came with it.
 *
 * QR targets, by variant:
 *   gift variants → /tribute/{gift_token}  — the recipient-safe tribute page,
 *                   the same URL the sender texts on day one.
 *   thank-you     → /story/{vault_token}   — the buyer's own Story Vault page
 *                   (with the remember-them date opt-in), falling back to the
 *                   tribute page when no vault exists.
 * Neither may ever be /order/{proof_token}, which reveals the order total and
 * grants proof approval — see 010-gift-note.sql.
 *
 * Output: output/note-cards/{orderId}.jpg
 */

const sharp = require('sharp');
const QRCode = require('qrcode');

// Requiring tributeRenderer first is what makes Cormorant available to sharp —
// it sets FONTCONFIG_PATH as a module side effect. Without it librsvg silently
// falls back to a generic serif and the note stops matching the frame.
const {
  loadTemplate, escSvg, wrapText, emitToOutput, FONT_SERIF, PAPER_PALETTE,
} = require('./tributeRenderer');

const NOTE_SUBDIR = 'note-cards';

const DPI = 300;
const PAGE_W = 8.5 * DPI;  // 2550 — Luma prints printouts on A4/letter stock.
const PAGE_H = 11 * DPI;   // 3300
const MARGIN = 1.2 * DPI;  // generous — this should feel like stationery

const BASE_URL = () => process.env.BASE_URL || 'http://localhost:3001';

// Character-width approximation for wrapping, matching tributeRenderer's
// convention (no server-side text metrics are available — librsvg rasterizes
// the SVG only after we have committed to the line breaks).
const charsPerLine = (innerW, fontSize) => Math.floor(innerW / (fontSize * 0.5));

// A small centered ornament: short rule — gold diamond — short rule. Gives the
// sheet stationery structure at each break rather than a bare line.
function ornament(cx, y, half = 150) {
  const c = PAPER_PALETTE;
  const gap = 26, d = 9;
  return `
    <line x1="${cx - half}" y1="${y}" x2="${cx - gap}" y2="${y}" stroke="${c.divider}" stroke-width="2"/>
    <rect x="${cx - d}" y="${y - d}" width="${d * 2}" height="${d * 2}" fill="${c.divider}" transform="rotate(45 ${cx} ${y})"/>
    <line x1="${cx + gap}" y1="${y}" x2="${cx + half}" y2="${y}" stroke="${c.divider}" stroke-width="2"/>`;
}

/**
 * Build the note card SVG.
 *
 * The brand mark is pinned to the top and the QR block to the bottom (its
 * geometry passed in via `qr`); the letter itself is measured and then centered
 * in the space between them. It has to work this way round: the note is
 * customer-authored, so its height isn't known until it has been wrapped, and a
 * top-down cursor would leave a short note stranded against the top of the page
 * with a dead zone beneath it.
 */
function buildNoteSvg({ recipientName, noteLines, senderName, qrCaption, qrSubline, qr }) {
  const c = PAPER_PALETTE;
  const cx = PAGE_W / 2;

  const brandSize = 40;
  const salutationSize = 96;
  const bodySize = 56;
  const bodyLeading = Math.round(bodySize * 1.66);
  const signSize = 62;

  const GAP_SALUTATION = Math.round(DPI * 0.5);  // salutation baseline → ornament
  const GAP_RULE = Math.round(DPI * 0.5);        // ornament → first body line
  const GAP_SIGN = Math.round(DPI * 0.5);        // last body line → signature

  const parts = [];

  // A double hairline border — turns a sheet of paper into a card.
  const b1 = Math.round(DPI * 0.55);
  parts.push(
    `<rect x="${b1}" y="${b1}" width="${PAGE_W - b1 * 2}" height="${PAGE_H - b1 * 2}" ` +
    `fill="none" stroke="${c.divider}" stroke-width="1.5" opacity="0.45"/>`
  );
  const b2 = b1 + 10;
  parts.push(
    `<rect x="${b2}" y="${b2}" width="${PAGE_W - b2 * 2}" height="${PAGE_H - b2 * 2}" ` +
    `fill="none" stroke="${c.divider}" stroke-width="0.75" opacity="0.3"/>`
  );

  // Brand mark — deliberately quiet. This is the sender's letter, not our ad.
  const brandY = MARGIN + brandSize;
  parts.push(
    `<text x="${cx}" y="${brandY}" font-family="${FONT_SERIF}" font-size="${brandSize}" ` +
    `fill="${c.dates}" text-anchor="middle" letter-spacing="7">STILL BESIDE ME</text>`
  );
  parts.push(ornament(cx, brandY + Math.round(DPI * 0.28), 90));

  // QR block text is authored here; the caption/subline positions come from qr.
  parts.push(ornament(cx, qr.topRuleY, 150));
  parts.push(
    `<text x="${cx}" y="${qr.captionY}" font-family="${FONT_SERIF}" font-size="34" ` +
    `fill="${c.dates}" text-anchor="middle" letter-spacing="4">${escSvg(qrCaption)}</text>`
  );
  // Bordered white "stamp" the QR bitmap lands on — reads as deliberate, and
  // the white ground plus cream page gives the code a wide light quiet zone.
  const pad = 26;
  parts.push(
    `<rect x="${qr.left - pad}" y="${qr.top - pad}" width="${qr.size + pad * 2}" height="${qr.size + pad * 2}" ` +
    `rx="14" fill="#ffffff" stroke="${c.divider}" stroke-width="1.5"/>`
  );
  parts.push(
    `<text x="${cx}" y="${qr.top + qr.size + pad + 52}" font-family="${FONT_SERIF}" font-size="30" ` +
    `fill="${c.family}" text-anchor="middle" font-style="italic">${escSvg(qrSubline)}</text>`
  );

  // Quiet brand footer — warmth to the recipient, not a receipt. (The recipient
  // did not order anything; a "thank you for your order" would break the moment.)
  // "Made with care", never "by hand" — the truth pass bans handcrafted claims;
  // the print is giclée and the frame is professionally assembled, not handmade.
  parts.push(
    `<text x="${cx}" y="${PAGE_H - MARGIN + 8}" font-family="${FONT_SERIF}" font-size="30" ` +
    `fill="${c.dates}" text-anchor="middle" letter-spacing="3">Made with care, for you · stillbesideme.com</text>`
  );

  // Measure the letter block, then center it between brand mark and QR ornament.
  let blockH = 0;
  if (recipientName) blockH += salutationSize + Math.round(DPI * 0.22) + Math.round(DPI * 0.28);
  blockH += GAP_RULE;
  blockH += noteLines.length * bodyLeading;
  if (senderName) blockH += GAP_SIGN + signSize;

  const regionTop = brandY + Math.round(DPI * 0.95);
  const regionBottom = qr.topRuleY - Math.round(DPI * 0.55);
  // Long notes top-align rather than creep into the QR. The server-side length
  // clamp is what keeps them from reaching that point in the first place.
  let y = Math.max(regionTop, regionTop + (regionBottom - regionTop - blockH) / 2);

  // Salutation — the resolver authors the full line ("For Rebecca",
  // "In memory of Roger"); omitted entirely when there is nothing to say
  // rather than printing a hollow greeting.
  if (recipientName) {
    y += salutationSize;
    parts.push(
      `<text x="${cx}" y="${Math.round(y)}" font-family="${FONT_SERIF}" font-size="${salutationSize}" ` +
      `fill="${c.name}" text-anchor="middle" font-weight="400">${escSvg(recipientName)}</text>`
    );
    y += Math.round(DPI * 0.22);
    parts.push(ornament(cx, Math.round(y), 120));
    y += Math.round(DPI * 0.28);
  } else {
    parts.push(ornament(cx, Math.round(y), 120));
    y += GAP_RULE;
  }

  // The message itself — the whole reason this sheet exists.
  for (const line of noteLines) {
    y += bodyLeading; // blank-line sentinels still advance, giving paragraph breaks
    if (line !== '') {
      parts.push(
        `<text x="${cx}" y="${Math.round(y)}" font-family="${FONT_SERIF}" font-size="${bodySize}" ` +
        `fill="${c.poem}" text-anchor="middle">${escSvg(line)}</text>`
      );
    }
  }

  // Signature (en dash by house rule — em dashes are banned project-wide)
  if (senderName) {
    y += GAP_SIGN + signSize;
    parts.push(
      `<text x="${cx}" y="${Math.round(y)}" font-family="${FONT_SERIF}" font-size="${signSize}" ` +
      `fill="${c.name}" text-anchor="middle" font-style="italic">– ${escSvg(senderName)}</text>`
    );
  }

  const svg =
    `<svg width="${PAGE_W}" height="${PAGE_H}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect width="${PAGE_W}" height="${PAGE_H}" fill="${c.background}"/>` +
    parts.join('') +
    `</svg>`;

  return Buffer.from(svg);
}

/**
 * Decide which card this order's box carries and what it says.
 *
 * Returns null only when there is nothing sensible to print (no QR target at
 * all — legacy orders predating both tokens).
 */
function resolveInsertContent(order, fields, template, vaultToken) {
  const noteText = (fields.giftNote || '').trim();
  const isGift = fields.orderType === 'gift';
  const shipping = order.shipping_json ? JSON.parse(order.shipping_json) : null;
  const recipientFirst = (shipping?.name || '').trim().split(/\s+/)[0] || '';
  const senderName = (fields.giftFrom || '').trim();
  const subjectName = (fields[(template.tributeMapping || {}).name] || '').trim();

  const tributeUrl = order.gift_token ? `${BASE_URL()}/tribute/${order.gift_token}` : null;
  const storyUrl = vaultToken ? `${BASE_URL()}/story/${vaultToken}` : null;

  const tributeCaption = subjectName
    ? `SCAN TO SEE ${subjectName.toUpperCase()}'S TRIBUTE`
    : 'SCAN TO SEE THEIR TRIBUTE';

  // A written message always wins, whatever the order type — the sender's own
  // words, exactly as before. (giftNote is only capturable in gift mode, but a
  // stored note must never be silently replaced by generic copy.)
  if (noteText) {
    if (!tributeUrl) return null;
    return {
      variant: 'personal-note',
      recipientName: recipientFirst ? `For ${recipientFirst}` : '',
      bodyText: noteText,
      senderName,
      qrUrl: tributeUrl,
      qrCaption: tributeCaption,
      qrSubline: 'A living tribute page, made just for them',
    };
  }

  // Gift without a message: the box must still say who it's from — giftFrom is
  // required at checkout for gift orders, so the sender line is always there.
  if (isGift) {
    if (!tributeUrl) return null;
    return {
      variant: 'gift-card',
      recipientName: recipientFirst ? `For ${recipientFirst}` : '',
      bodyText:
        `This was made for you, with love.\n\n` +
        `${subjectName ? `A tribute to ${subjectName}, printed` : 'A tribute, printed'} on archival paper\n` +
        `and professionally framed.`,
      senderName,
      qrUrl: tributeUrl,
      qrCaption: tributeCaption,
      qrSubline: 'A living tribute page, made just for them',
    };
  }

  // Self purchase: a thank-you with a care line. QR goes to their Story Vault
  // page (remember-them opt-in) when one exists, else the tribute page.
  const qrUrl = storyUrl || tributeUrl;
  if (!qrUrl) return null;
  return {
    variant: 'thank-you',
    recipientName: subjectName ? `In memory of ${subjectName}` : '',
    bodyText:
      `Thank you for letting us help remember ${subjectName || 'them'}.\n\n` +
      `This tribute was printed on archival paper\n` +
      `and professionally framed. Kept out of direct sunlight,\n` +
      `it will hold its color for decades.`,
    senderName: '',
    qrUrl,
    qrCaption: subjectName
      ? `SCAN TO VISIT ${subjectName.toUpperCase()}'S PAGE`
      : 'SCAN TO VISIT THEIR PAGE',
    qrSubline: storyUrl ? 'Their story, kept. Visit anytime.' : 'A living tribute page, made just for them',
  };
}

/**
 * Render the insert card for an order — one card in every physical box.
 *
 * @param {object} order — full order row
 * @param {object} [opts] — { vaultToken } for the self-purchase Story Vault QR
 * @returns {Promise<{notePath, noteRelativeUrl, variant}|null>} null only when
 *          the order has no QR target at all (legacy pre-token orders)
 */
async function generateNoteCard(order, opts = {}) {
  // Deliberately NOT resolveOrderData: that resolves photos and throws without
  // one. A note card is words on paper — it has no photo, and coupling it to
  // one would block the no-photo tributes the sympathy-gift case needs.
  const fields = order.fields_json ? JSON.parse(order.fields_json) : {};

  const template = loadTemplate(order.template_id);
  if (!template) throw new Error(`Template not found: ${order.template_id}`);

  const content = resolveInsertContent(order, fields, template, opts.vaultToken || null);
  if (!content) {
    console.warn(`Order ${order.id}: no QR target (no gift/vault token) — no insert card`);
    return null;
  }

  const { recipientName, bodyText, senderName, qrUrl: tributeUrl, qrCaption, qrSubline } = content;

  const innerW = PAGE_W - MARGIN * 2;
  const noteLines = wrapText(bodyText, charsPerLine(innerW, 56));

  // QR geometry, bottom-anchored. 1.4in puts a version-5 code at ~0.9mm per
  // module — clear of the ~0.5mm scan floor, with room for ink spread on
  // whatever stock Luma runs. Leave room below for the italic sub-line + footer.
  const qrSize = Math.round(DPI * 1.4);
  const qrLeft = Math.round((PAGE_W - qrSize) / 2);
  const qrTop = PAGE_H - MARGIN - qrSize - Math.round(DPI * 0.42);
  const qr = {
    size: qrSize, left: qrLeft, top: qrTop,
    captionY: qrTop - Math.round(DPI * 0.26),
    topRuleY: qrTop - Math.round(DPI * 0.6),
  };

  const svg = buildNoteSvg({ recipientName, noteLines, senderName, qrCaption, qrSubline, qr });

  // QR rendered directly at final pixel size — scaling a QR after the fact
  // softens the module edges and costs scan reliability. margin:2 builds a
  // two-module quiet zone into the bitmap; it sits on the white SVG stamp, so
  // the light surround extends well past that into the cream page.
  const qrBuffer = await QRCode.toBuffer(tributeUrl, {
    type: 'png',
    width: qrSize,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: PAPER_PALETTE.name, light: '#ffffff' },
  });

  const noteBuffer = await sharp({
    create: { width: PAGE_W, height: PAGE_H, channels: 3, background: PAPER_PALETTE.background },
  })
    .composite([
      { input: svg, left: 0, top: 0 },
      { input: qrBuffer, left: qrLeft, top: qrTop },
    ])
    .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
    .toBuffer();

  const { absPath: notePath, relativeUrl: noteRelativeUrl } =
    emitToOutput(NOTE_SUBDIR, `${order.id}.jpg`, noteBuffer);

  const sizeMB = (noteBuffer.length / (1024 * 1024)).toFixed(1);
  console.log(`Insert card generated (${content.variant}): ${noteRelativeUrl} (${PAGE_W}x${PAGE_H}, ${sizeMB}MB)`);

  return { notePath, noteRelativeUrl, variant: content.variant };
}

module.exports = { generateNoteCard, resolveInsertContent };
