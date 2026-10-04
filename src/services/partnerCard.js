/**
 * The card a partner practice hands to a family: 4x6 inches, so it fits inside
 * a sympathy card or can be left on a table after a home visit.
 *
 * Same cream paper and the same Cormorant as the tribute itself, so the first
 * thing a family holds from us already looks like the thing they will get. It
 * says who the gift is from, what it is in one plain sentence, that it costs
 * nothing, and that there is no hurry. The QR and the written link go to the
 * practice's own /gift/<slug>, which is how the keepsake and any framed order
 * after it are credited to them.
 *
 * Rendered on demand for the admin to download and print. Nothing is stored.
 */

const sharp = require('sharp');
const QRCode = require('qrcode');

// Requiring tributeRenderer first is what makes Cormorant available to sharp
// (it sets FONTCONFIG_PATH as a module side effect).
const { escSvg, wrapText, FONT_SERIF, PAPER_PALETTE } = require('./tributeRenderer');

const DPI = 300;
const CARD_W = 4 * DPI;   // 1200
const CARD_H = 6 * DPI;   // 1800

const BODY = 'Send us a favorite photo and tell us a little about them. '
  + 'We will write a short poem from what you share and set it beside the photo, '
  + 'a keepsake for you to hold on to.';

function giftUrlFor(partner) {
  const base = process.env.BASE_URL || 'http://localhost:3001';
  return `${base}/gift/${partner.slug}`;
}

/** The link as it reads on paper: no scheme, no www. */
function printedLink(url) {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '');
}

/**
 * @param {object} partner — partners row
 * @returns {Promise<Buffer>} PNG, 1200x1800 (4x6 at 300 DPI)
 */
async function renderPartnerCard(partner) {
  const c = PAPER_PALETTE;
  const cx = CARD_W / 2;
  const url = giftUrlFor(partner);

  const qrSize = 420;
  const qrTop = 1080;
  const qrLeft = Math.round(cx - qrSize / 2);

  const parts = [];

  // Hairline border, as on the note card in the box.
  const inset = 60;
  parts.push(`<rect x="${inset}" y="${inset}" width="${CARD_W - inset * 2}" height="${CARD_H - inset * 2}" fill="none" stroke="${c.divider}" stroke-width="1.5" opacity="0.5"/>`);

  parts.push(`<text x="${cx}" y="190" font-family="${FONT_SERIF}" font-size="30" letter-spacing="6" fill="${c.family}" text-anchor="middle">STILL BESIDE ME</text>`);

  // "A gift from" small, then the practice's name large, wrapped if long.
  parts.push(`<text x="${cx}" y="320" font-family="${FONT_SERIF}" font-size="44" font-style="italic" fill="${c.family}" text-anchor="middle">A gift from</text>`);
  const nameLines = wrapText(partner.name, 22).filter(Boolean).slice(0, 3);
  const nameSize = nameLines.length > 2 ? 62 : 72;
  let y = 420;
  for (const line of nameLines) {
    parts.push(`<text x="${cx}" y="${y}" font-family="${FONT_SERIF}" font-size="${nameSize}" fill="${c.name}" text-anchor="middle">${escSvg(line)}</text>`);
    y += Math.round(nameSize * 1.15);
  }

  // Divider
  const ruleY = y + 10;
  parts.push(`<line x1="${cx - 90}" y1="${ruleY}" x2="${cx + 90}" y2="${ruleY}" stroke="${c.divider}" stroke-width="2"/>`);

  // Body, then the two reassurances that matter most to someone on that day.
  y = ruleY + 90;
  for (const line of wrapText(BODY, 34).filter(Boolean)) {
    parts.push(`<text x="${cx}" y="${y}" font-family="${FONT_SERIF}" font-size="40" fill="${c.poem}" text-anchor="middle">${escSvg(line)}</text>`);
    y += 56;
  }
  y += 24;
  parts.push(`<text x="${cx}" y="${y}" font-family="${FONT_SERIF}" font-size="40" font-style="italic" fill="${c.poem}" text-anchor="middle">There is no cost. Whenever you are ready.</text>`);

  // QR plate and the link written out for anyone who would rather type it.
  parts.push(`<rect x="${qrLeft - 16}" y="${qrTop - 16}" width="${qrSize + 32}" height="${qrSize + 32}" rx="10" fill="#ffffff" stroke="${c.divider}" stroke-width="1.5" opacity="0.9"/>`);
  parts.push(`<text x="${cx}" y="${qrTop + qrSize + 90}" font-family="${FONT_SERIF}" font-size="36" fill="${c.name}" text-anchor="middle">${escSvg(printedLink(url))}</text>`);

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_W}" height="${CARD_H}">${parts.join('')}</svg>`
  );

  const qrBuffer = await QRCode.toBuffer(url, {
    type: 'png',
    width: qrSize,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: c.name, light: '#ffffff' },
  });

  return sharp({
    create: { width: CARD_W, height: CARD_H, channels: 3, background: c.background },
  })
    .composite([
      { input: svg, left: 0, top: 0 },
      { input: qrBuffer, left: qrLeft, top: qrTop },
    ])
    .withMetadata({ density: DPI })
    .png()
    .toBuffer();
}

module.exports = { renderPartnerCard, giftUrlFor };
