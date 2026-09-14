/**
 * Reading an Etsy receipt, and refusing to read one we do not understand.
 *
 * This is the file that decides what gets printed and mailed to somebody whose
 * dog just died. It does that by reading strings that no one in this shop has
 * ever seen. There have been zero Etsy sales, and Etsy will not let a seller
 * buy from their own shop, so the exact wording of the size option, the frame
 * option and the five personalization questions is unknown until a stranger
 * pays us money. Everything here is written against that.
 *
 * So the rule is one sentence: refuse, never guess.
 *
 * A refusal costs David five minutes retyping the order into /admin/intake, a
 * form that already exists and already works. A wrong guess costs a reprint, a
 * second week of waiting, and the trust of somebody who is grieving. Those two
 * are not close, so every ambiguity in this file resolves the same way. If the
 * size does not match a product we actually sell, we refuse. If the frame does
 * not match a frame we actually stock, we refuse. We never let orderIntake's
 * silent fallbacks (11x14 for an unparseable sku, black for an unknown frame)
 * stand in for an answer, because those fallbacks were written for our own
 * checkout, where the values can only ever be ones we put on the page.
 *
 * Two functions, and the split matters:
 *
 *   receiptToIntake  pure. No network, no database, no clock. Given a receipt
 *                    and the template, it returns either a mapped order or a
 *                    refusal code. Because it is pure it can be tested against
 *                    hand-built fixtures, which is the only kind of Etsy
 *                    receipt anyone can produce today. See tests/etsy-mapper.js.
 *
 *   ingestReceipt    everything with a consequence: downloading the buyer's
 *                    photos, creating the order, alerting a human, and keeping
 *                    a copy of the raw receipt so that the next person to work
 *                    on this has the fixture we never had.
 *
 * ingestReceipt never throws. A pull loop that dies on the third receipt of
 * five leaves two orders in and three nowhere, so every path here ends in an
 * outcome the caller can record and move on from.
 */

const etsySettings = require('./etsySettings');

/**
 * Why a receipt was sent back to a human, in words a human can act on. Each
 * one ends the same way on purpose: there is always somewhere to go next, and
 * it is always the form that already works.
 */
const REFUSAL = Object.freeze({
  MULTI_TRANSACTION:
    'This Etsy order has more than one item on it, and an order here can only hold one tribute. ' +
    'Enter each item by hand at /admin/intake.',
  QUANTITY:
    'The buyer ordered more than one of this item, and the printer is only ever told to make one. ' +
    'Enter it by hand at /admin/intake, once per print.',
  UNKNOWN_SIZE:
    'The size on this Etsy order does not match any size we sell, so nothing here knows how big to print it. ' +
    'Enter it by hand at /admin/intake.',
  UNKNOWN_FRAME:
    'The frame on this Etsy order does not match any frame we stock, and the wrong frame means a reprint. ' +
    'Enter it by hand at /admin/intake.',
  FRAME_TOO_SMALL:
    'The buyer picked a signature frame on a size we do not offer it in, so the order cannot be built as it stands. ' +
    'Check the Etsy listing, then enter the order by hand at /admin/intake.',
  NO_PHOTOS:
    'No photo came through on this Etsy order, and there is nothing to print without one. ' +
    'Get the photo from the buyer, then enter the order by hand at /admin/intake.',
  NO_PET_NAME:
    'This Etsy order has no pet name on it, and the name is printed on the piece. ' +
    'Ask the buyer, then enter the order by hand at /admin/intake.',
  BAD_CURRENCY:
    'This Etsy order was paid in a currency other than US dollars, so the total on the record would be wrong. ' +
    'Enter it by hand at /admin/intake with the converted amount.',
  NOT_PAID:
    'Etsy has not marked this order as paid, so nothing should be made yet. ' +
    'Wait for the payment to clear, or enter it by hand at /admin/intake once it has.',
  CANCELED:
    'This Etsy order is canceled. Nothing was created. ' +
    'If it was canceled by mistake, enter it by hand at /admin/intake.',
});

/** Etsy serves buyer uploads from its own CDN and nowhere else. */
const PHOTO_HOST = 'etsystatic.com';
/** Matches the multer limit on the manual form, so both doors accept the same files. */
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_PHOTOS = 3;

const BASE_URL = () => process.env.BASE_URL || 'http://localhost:3001';

// ─── Small readers ───────────────────────────────────────────────────

/** Lowercase, punctuation out, runs of space collapsed. Comparison form only. */
function normalize(value) {
  return String(value == null ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function text(entry) {
  if (!entry) return '';
  return String(entry.formatted_value == null ? '' : entry.formatted_value).trim();
}

function str(value) {
  return String(value == null ? '' : value).trim();
}

/**
 * Which personalization question an answer belongs to, worked out from its
 * name rather than its position.
 *
 * Position is a trap here. The years question is optional, and an unanswered
 * optional question is likely to be absent from the receipt rather than
 * present and empty, which slides every answer after it up by one. Read that
 * way, the buyer's life dates become their pet's name and the photo URL
 * becomes their story. So we look at what each question is called.
 *
 * Order matters: the loosest pattern ('name') is tested last, so it cannot
 * swallow a question that some other pattern would have claimed.
 */
const ANSWER_MATCHERS = [
  ['photo', /\b(photo|photos|upload|uploads|image|images|picture|pictures)\b/],
  ['poemChoice', /\b(own words|my words|write it for me|poem|words|wording)\b/],
  ['years', /\b(year|years|date|dates|born|birth|passed)\b/],
  ['about', /\b(tell us|about|story|memory|memories)\b/],
  ['petName', /\bname\b/],
];

/** The order the live listing asks its five questions, used only as a last resort. */
const ANSWER_POSITIONS = ['petName', 'years', 'about', 'poemChoice', 'photo'];

/** Every https URL in a blob of text, deduped, trailing punctuation trimmed. */
function extractUrls(blob) {
  const found = String(blob || '').match(/https:\/\/[^\s<>"']+/g) || [];
  const seen = [];
  for (const raw of found) {
    const url = raw.replace(/[.,;:)\]}>]+$/, '');
    if (url && !seen.includes(url)) seen.push(url);
  }
  return seen;
}

function refuse(code, detail, warnings) {
  return {
    ok: false,
    code,
    reason: detail ? `${REFUSAL[code]} (${detail})` : REFUSAL[code],
    warnings,
  };
}

// ─── The mapper ──────────────────────────────────────────────────────

/**
 * Turn one Etsy receipt into the object createFromMarketplace wants, or say
 * why it cannot be done.
 *
 * Pure. Nothing in here touches the network, the database, the filesystem or
 * the clock, which is what makes it testable against invented receipts.
 *
 * @param {object} receipt   a ShopReceipt as Etsy's API returns it
 * @param {object} template  the loaded pet-tribute template
 * @returns {{ok: true, intake: object, photoUrls: string[], warnings: string[]}
 *          |{ok: false, code: string, reason: string, warnings: string[]}}
 */
function receiptToIntake(receipt, template) {
  const warnings = [];

  if (!receipt || typeof receipt !== 'object') {
    return refuse('MULTI_TRANSACTION', 'the receipt was empty', warnings);
  }
  const receiptId = str(receipt.receipt_id);

  // The list call filters on was_paid and was_canceled, but a filter is a
  // request and this is the record. Check the receipt itself, every time.
  const status = normalize(receipt.status);
  if (status === 'canceled' || status === 'cancelled' || receipt.is_canceled === true) {
    return refuse('CANCELED', null, warnings);
  }
  if (receipt.is_paid !== true && status !== 'paid' && status !== 'completed') {
    return refuse('NOT_PAID', `Etsy status "${str(receipt.status) || 'none'}"`, warnings);
  }

  // One receipt, one tribute. orders.etsy_receipt_id carries a UNIQUE index, so
  // a receipt holding two items has no way to be represented: the second order
  // would collide with the first and the buyer would get half their order.
  //
  // The forward path, if two-item receipts ever become common enough to be
  // worth it: the natural key is receipt_id:transaction_id, not receipt_id, and
  // every row would carry that instead. Changing the column means rebuilding
  // the table, because sql.js cannot alter a constraint in place. The pattern
  // to copy is the recreate-and-copy in migrations/007-review-gate.sql.
  const transactions = Array.isArray(receipt.transactions) ? receipt.transactions : [];
  if (transactions.length !== 1) {
    return refuse('MULTI_TRANSACTION', `${transactions.length} items on the receipt`, warnings);
  }
  const tx = transactions[0];

  // Luma is told quantity 1, always. A buyer who ordered two would get one
  // print and no complaint from anything in this system until they emailed.
  const quantity = Number(tx.quantity);
  if (quantity !== 1) {
    return refuse('QUANTITY', `quantity ${str(tx.quantity) || 'missing'}`, warnings);
  }

  // Personalization answers are the variations that carry a question_id.
  // Product variations (Size, Frame) have question_id null. This is the only
  // reliable way to tell them apart; their position in the array is not.
  const variations = Array.isArray(tx.variations) ? tx.variations : [];
  const answers = variations.filter(v => v && v.question_id != null);
  const options = variations.filter(v => v && v.question_id == null);

  // ── The buyer's answers ────────────────────────────────────────────
  const slots = { petName: null, years: null, about: null, poemChoice: null, photo: [] };
  for (const entry of answers) {
    const name = normalize(entry.formatted_name);
    const matcher = ANSWER_MATCHERS.find(([, re]) => re.test(name));
    if (!matcher) continue;
    const key = matcher[0];
    if (key === 'photo') { slots.photo.push(entry); continue; }
    if (!slots[key]) slots[key] = entry;
  }

  // If not one question name looked familiar, the listing has been reworded
  // and we fall back to the order the questions are asked in. We only do this
  // when the count is exactly right, and we say so loudly, because reading by
  // position is the mistake this whole function is built to avoid.
  if (!slots.petName && answers.length === ANSWER_POSITIONS.length) {
    warnings.push(
      'None of the Etsy question names were recognized, so the answers were read in the order the ' +
      'listing asks them. Check every field on the review page before this is printed.'
    );
    ANSWER_POSITIONS.forEach((key, i) => {
      const entry = answers[i];
      if (!entry) return;
      if (key === 'photo') { if (!slots.photo.length) slots.photo.push(entry); return; }
      if (!slots[key]) slots[key] = entry;
    });
  }

  const petName = text(slots.petName);
  if (!petName) return refuse('NO_PET_NAME', null, warnings);

  // Years arrive as one string. The renderer joins birthDate and passDate with
  // an en dash of its own, so both are stored separately and either spelling
  // of the buyer's dash renders the same.
  let birthDate = '';
  let passDate = '';
  const yearsText = text(slots.years);
  if (yearsText) {
    const parts = yearsText.split(/[-\u2013\u2014]/).map(p => p.trim());
    if (parts.length === 1) {
      birthDate = parts[0];
    } else if (parts.length === 2) {
      birthDate = parts[0];
      passDate = parts[1];
    } else {
      birthDate = yearsText;
      warnings.push(
        `The years answer has more than one dash in it ("${yearsText}"), so it was left as one value. ` +
        'Split it by hand on the review page if it should read as two dates.'
      );
    }
  }

  const aboutText = text(slots.about);
  if (!slots.about) {
    warnings.push('The buyer did not answer the "tell us about them" question, so the poem has very little to work from.');
  }
  if (!slots.poemChoice) {
    warnings.push('The poem question was not answered on this order, so a poem will be written for them. Check that is what they wanted.');
  }

  // Match the dropdown on what it means, not on the exact sentence, because
  // the option text can be reworded on the listing at any time.
  const wantsOwnWords = /\b(own|my words)\b/.test(normalize(text(slots.poemChoice)));
  if (wantsOwnWords && !aboutText) {
    warnings.push('The buyer said they have their own words but sent no text with the order. Their poem is empty and has to be chased.');
  }

  // Photos. Etsy's file-upload answer puts the URL in formatted_value, but one
  // answer can hold three files and a reworded listing could hold two answers,
  // so pull every URL out of every photo answer rather than assuming a shape.
  let photoUrls = extractUrls(slots.photo.map(text).join('\n'));
  if (!photoUrls.length) {
    // Nothing matched the photo question by name. A URL anywhere in the
    // buyer's answers is still worth trying: the download step below only
    // accepts Etsy's own CDN, so a stray link cannot become a print.
    const scanned = extractUrls(answers.map(text).join('\n'));
    if (scanned.length) {
      photoUrls = scanned;
      warnings.push('The photo question was not recognized by name, so the photos were found by scanning the buyer\'s answers for links.');
    }
  }
  if (!photoUrls.length) return refuse('NO_PHOTOS', null, warnings);
  if (photoUrls.length > MAX_PHOTOS) {
    warnings.push(`The buyer sent ${photoUrls.length} photos and the first ${MAX_PHOTOS} were kept.`);
    photoUrls = photoUrls.slice(0, MAX_PHOTOS);
  }

  // ── What they bought ───────────────────────────────────────────────
  const products = Array.isArray(template.printProducts) ? template.printProducts : [];
  const listingSku = str(tx.sku);
  let sku = '';
  let sizeVar = null;

  if (listingSku && products.some(p => p.sku === listingSku)) {
    // The listing carries our own SKU. Nothing to interpret.
    sku = listingSku;
  } else {
    if (listingSku) {
      warnings.push(`Etsy sent SKU "${listingSku}", which is not one of ours, so the size was read from the size option instead.`);
    }
    // Strip inch marks and smart quotes before reading the dimensions. A size
    // option is far more likely to read 11" x 14" than 11x14, and \s* will not
    // cross the quote character, so without this the commonest spelling of the
    // commonest option refuses every order and the integration looks broken
    // rather than careful. Anything that still does not resolve to a real SKU
    // is refused below, so reading more spellings here costs no safety.
    const sizeText = v => str(v && v.formatted_value).replace(/["'\u2018\u2019\u201c\u201d\u2032\u2033]/g, '');
    sizeVar = options.find(v => /\bsize\b/.test(normalize(v.formatted_name)))
      || options.find(v => /(\d+)\s*[x\u00d7]\s*(\d+)/i.test(sizeText(v)));
    const dims = sizeVar ? sizeText(sizeVar).match(/(\d+)\s*[x\u00d7]\s*(\d+)/i) : null;
    if (!dims) {
      return refuse('UNKNOWN_SIZE', sizeVar ? `Etsy said "${str(sizeVar.formatted_value)}"` : 'no size option on the receipt', warnings);
    }
    sku = `framed-${dims[1]}x${dims[2]}`;
    if (!products.some(p => p.sku === sku)) {
      return refuse('UNKNOWN_SIZE', `Etsy said "${str(sizeVar.formatted_value)}", which reads as ${sku}`, warnings);
    }
  }

  const skuDims = sku.match(/(\d+)x(\d+)/);
  const shortSideIn = skuDims ? Math.min(Number(skuDims[1]), Number(skuDims[2])) : 0;

  // ── The frame ──────────────────────────────────────────────────────
  // Resolved here rather than left to orderIntake.resolveFrame, which answers
  // 'black' to anything it does not recognize. By the time it sees this value
  // the value is already one of its own ids, so that fallback cannot fire.
  let frameChoice = null;
  if (sku.startsWith('framed-')) {
    const frameVar = options.find(v => v !== sizeVar && /\b(frame|frames|colour|color|finish)\b/.test(normalize(v.formatted_name)));
    if (!frameVar) {
      return refuse('UNKNOWN_FRAME', 'no frame option on the receipt', warnings);
    }
    const wanted = normalize(frameVar.formatted_value);
    let matched = null;
    let matchedGroup = null;
    for (const group of (template.frameOptions && template.frameOptions.groups) || []) {
      const choice = (group.choices || []).find(
        c => normalize(c.id) === wanted || normalize(c.label) === wanted
      );
      if (choice) { matched = choice; matchedGroup = group; break; }
    }
    if (!matched) {
      return refuse('UNKNOWN_FRAME', `Etsy said "${str(frameVar.formatted_value)}"`, warnings);
    }
    if (matchedGroup.minShortSideIn && shortSideIn < matchedGroup.minShortSideIn) {
      return refuse(
        'FRAME_TOO_SMALL',
        `${matched.label} starts at ${matchedGroup.minShortSideIn} inches on the short side and this is a ${skuDims[1]}x${skuDims[2]}`,
        warnings
      );
    }
    frameChoice = matched.id;
  }

  // ── The money ──────────────────────────────────────────────────────
  // grandtotal is a Money object, never a number: { amount, divisor,
  // currency_code }. Read as a number it would be a hundred times the price.
  let totalCents = null;
  const money = receipt.grandtotal;
  if (money && typeof money === 'object') {
    // A missing currency code is refused too. Treating it as dollars would take
    // a 119 pound sale and write it on the order as $119.00, which reads as
    // correct at every later glance. Everything else in this file refuses on
    // ambiguity and this is no different.
    const currency = String(money.currency_code || '').toUpperCase();
    if (currency !== 'USD') {
      return refuse('BAD_CURRENCY', currency ? `Etsy collected ${currency}` : 'the receipt carried no currency code', warnings);
    }
    const amount = Number(money.amount);
    const divisor = Number(money.divisor);
    if (Number.isFinite(amount) && Number.isFinite(divisor) && divisor > 0) {
      totalCents = Math.round((amount / divisor) * 100);
    } else {
      warnings.push('The grand total on this receipt could not be read, so the order shows the list price for that size.');
    }
  } else {
    warnings.push('This receipt carried no grand total, so the order shows the list price for that size.');
  }

  // ── Where it goes ──────────────────────────────────────────────────
  // address1/address2, not line1/line2. Luma reads shipping.address1 and so
  // does the admin order pane; anything else ships a parcel with a city and no
  // street while looking right on screen. createFromMarketplace throws on the
  // old spelling, which is how this stays true.
  const shipping = {
    name: str(receipt.name),
    address1: str(receipt.first_line),
    address2: str(receipt.second_line),
    city: str(receipt.city),
    state: str(receipt.state),
    zip: str(receipt.zip),
    country: str(receipt.country_iso) || 'US',
  };
  if (!shipping.address1 || !shipping.zip) {
    warnings.push('This Etsy order is missing part of its shipping address. Fill it in before it goes to print.');
  }
  if (!str(receipt.country_iso)) {
    warnings.push('The receipt had no country on it, so it was recorded as US. Check that.');
  } else if (shipping.country.toUpperCase() !== 'US') {
    warnings.push(`This order ships to ${shipping.country}. Luma prints and ships inside the US, so check the shipping cost before it goes to print.`);
  }

  // ── The record ─────────────────────────────────────────────────────
  // The buyer's own words, kept verbatim on admin_notes as well as in the
  // fields, so that they are on the dashboard whatever happens to the poem.
  // Buyers put "her name is spelled Bailee" and "please use the second photo"
  // in the checkout message, and that must never be dropped.
  const buyerMessage = str(receipt.message_from_buyer);
  const giftMessage = str(receipt.gift_message);
  const notes = [
    `Etsy receipt ${receiptId}.`,
    aboutText
      ? `What the buyer told us about them, in their own words:\n${aboutText}`
      : 'The buyer did not answer the "tell us about them" question.',
    buyerMessage ? `Message from the buyer at checkout:\n${buyerMessage}` : null,
    giftMessage ? `Gift message on the order:\n${giftMessage}` : null,
  ].filter(Boolean).join('\n\n');

  const fields = { petName };
  if (birthDate) fields.birthDate = birthDate;
  if (passDate) fields.passDate = passDate;
  if (!wantsOwnWords && aboutText) fields.favoriteMemory = aboutText;

  const intake = {
    source: 'etsy',
    etsyReceiptId: receiptId,
    templateId: template.id,
    sku,
    fields,
    shipping,
    notes,
  };
  if (frameChoice) intake.frameChoice = frameChoice;
  if (wantsOwnWords && aboutText) intake.ownPoem = aboutText;
  if (totalCents != null) intake.totalCents = totalCents;

  // Etsy never asks what kind of animal it was, and there is no way to add a
  // sixth question that only some buyers see. poemGenerator falls back to the
  // word "pet", which reads as generic in a poem about a horse.
  warnings.push('Etsy does not ask what kind of pet it was, so the poem is written without that. Set it on the review page before generating.');

  if (receipt.is_gift === true) {
    warnings.push('Etsy marked this as a gift. An order created here is always built as a self order, so the plain note card will be used, not the gift one.');
  }

  return { ok: true, intake, photoUrls, warnings };
}

// ─── Downloading what the buyer uploaded ─────────────────────────────

/**
 * Fetch one buyer photo from Etsy's CDN.
 *
 * The checks here are not paranoia about Etsy. They are about the fact that
 * this URL arrives inside a string field that a stranger can type into: if a
 * photo answer can be rewritten, this function is the thing that stops the
 * server being asked to fetch an arbitrary address. https only, Etsy's own CDN
 * only, and redirect: 'error', because Node's fetch follows redirects by
 * default and one hop to anywhere would defeat the host check entirely.
 *
 * The byte cap is enforced while reading rather than read off content-length,
 * which is a number the other end chooses.
 */
async function downloadPhoto(url, index) {
  const label = `photo ${index + 1}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${label} is not a usable link`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`${label} is not an https link`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== PHOTO_HOST && !host.endsWith(`.${PHOTO_HOST}`)) {
    throw new Error(`${label} is hosted at ${host}, which is not Etsy`);
  }

  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    throw new Error(`${label} came back ${res.status} from Etsy`);
  }
  const contentType = String(res.headers.get('content-type') || '').toLowerCase();
  if (!contentType.startsWith('image/')) {
    throw new Error(`${label} is not an image (Etsy sent ${contentType || 'nothing'})`);
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_PHOTO_BYTES) {
      await reader.cancel();
      throw new Error(`${label} is larger than ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)}MB`);
    }
    chunks.push(Buffer.from(value));
  }
  if (!total) throw new Error(`${label} arrived empty`);

  const base = decodeURIComponent(parsed.pathname.split('/').pop() || '');
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '');
  return {
    buffer: Buffer.concat(chunks),
    originalName: /\.[A-Za-z0-9]{2,5}$/.test(safe) ? safe : `etsy-photo-${index + 1}.jpg`,
  };
}

// ─── The consequences ────────────────────────────────────────────────

/** Best effort, always. A mail failure must never fail or repeat an ingest. */
async function alertAdmin(subject, body) {
  try {
    const emailService = require('./emailService');
    await emailService.sendAdminAlert(subject, body);
  } catch (err) {
    console.error(`[etsyIngest] admin alert "${subject}" failed to send: ${err.message}`);
  }
}

/**
 * Keep the raw receipt.
 *
 * This is the only fixture anyone will ever have of a real Etsy receipt for
 * this listing, and the mapper above was written blind because it does not
 * exist yet. It goes in the database and never in an email: a receipt carries
 * a buyer's full name and street address.
 */
function recordSample(db, receipt) {
  try {
    const meta = etsySettings.getJson(db, 'etsy.meta') || {};
    meta.lastReceiptSample = receipt;
    etsySettings.setJson(db, 'etsy.meta', meta);
  } catch (err) {
    console.error(`[etsyIngest] could not store the receipt sample: ${err.message}`);
  }
}

/**
 * Take one receipt as far as it can honestly go.
 *
 * @param {object} db
 * @param {object} receipt          a ShopReceipt from Etsy
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]   map it and show the result, touch nothing
 *
 * @returns {Promise<{receiptId, outcome, reason, orderId, reviewUrl, warnings}>}
 *          outcome is 'created' | 'would-create' | 'duplicate' | 'refused' | 'error'
 */
async function ingestReceipt(db, receipt, { dryRun = false } = {}) {
  const receiptId = receipt && receipt.receipt_id != null ? String(receipt.receipt_id) : 'unknown';
  const result = {
    receiptId,
    outcome: 'error',
    reason: null,
    orderId: null,
    reviewUrl: null,
    warnings: [],
  };

  let mapped;
  try {
    const { loadTemplate } = require('./tributeRenderer');
    const template = loadTemplate('pet-tribute');
    if (!template) throw new Error('the pet-tribute template could not be loaded');
    mapped = receiptToIntake(receipt, template);
  } catch (err) {
    result.reason = `Etsy receipt ${receiptId} could not be read: ${err.message}`;
    console.error(`[etsyIngest] receipt ${receiptId} failed to map: ${err.message}`);
    await alertAdmin(
      `Etsy order ${receiptId} could not be read`,
      `Etsy receipt: ${receiptId}\n` +
      `Step: reading the receipt\n` +
      `Error: ${err.message}\n\n` +
      `Enter the order by hand: ${BASE_URL()}/admin/intake`
    );
    return result;
  }

  result.warnings = mapped.warnings;

  // A dry run is for looking at the first real receipt before anything is
  // made from it, so it writes nothing, downloads nothing and emails nobody.
  if (dryRun) {
    result.outcome = mapped.ok ? 'would-create' : 'refused';
    result.reason = mapped.ok ? null : mapped.reason;
    if (mapped.ok) {
      result.intake = mapped.intake;
      result.photoUrls = mapped.photoUrls;
    } else {
      result.code = mapped.code;
    }
    return result;
  }

  recordSample(db, receipt);

  if (!mapped.ok) {
    result.outcome = 'refused';
    result.reason = mapped.reason;
    result.code = mapped.code;
    console.warn(`[etsyIngest] receipt ${receiptId} refused: ${mapped.code}`);
    await alertAdmin(
      `Etsy order ${receiptId} needs to be entered by hand`,
      `Etsy receipt: ${receiptId}\n` +
      `Step: turning the receipt into an order\n` +
      `Why: ${mapped.reason}\n\n` +
      (mapped.warnings.length ? `Also worth knowing:\n${mapped.warnings.map(w => `  - ${w}`).join('\n')}\n\n` : '') +
      `Enter the order by hand: ${BASE_URL()}/admin/intake`
    );
    return result;
  }

  // Photos first and all of them, before a single row is written. A receipt
  // whose second photo will not download must not leave half an order behind.
  let photos;
  try {
    photos = [];
    for (let i = 0; i < mapped.photoUrls.length; i++) {
      photos.push(await downloadPhoto(mapped.photoUrls[i], i));
    }
  } catch (err) {
    result.outcome = 'error';
    result.reason = `The photos on Etsy order ${receiptId} could not be fetched: ${err.message}. Nothing was created.`;
    console.error(`[etsyIngest] receipt ${receiptId} photo download failed: ${err.message}`);
    await alertAdmin(
      `Etsy order ${receiptId}: the photos would not download`,
      `Etsy receipt: ${receiptId}\n` +
      `Step: downloading the buyer's photos from Etsy\n` +
      `Error: ${err.message}\n\n` +
      `Nothing was created, so nothing is half made. Save the photos from the Etsy order and enter it by hand: ${BASE_URL()}/admin/intake`
    );
    return result;
  }

  try {
    const orderIntake = require('./orderIntake');
    const created = await orderIntake.createFromMarketplace(db, { ...mapped.intake, photos });
    result.outcome = 'created';
    result.orderId = created.orderId;
    result.reviewUrl = `/admin/review/${created.adminToken}`;

    db.run(
      'INSERT INTO order_events (order_id, event_type, data_json) VALUES (?, ?, ?)',
      [created.orderId, 'etsy_order_ingested', JSON.stringify({
        etsyReceiptId: receiptId,
        sku: mapped.intake.sku,
        frameChoice: mapped.intake.frameChoice || null,
        photoCount: photos.length,
        buyerSuppliedPoem: !!mapped.intake.ownPoem,
        warnings: mapped.warnings,
        ingestedAt: new Date().toISOString(),
      })]
    );

    const shortId = created.orderId.substring(0, 8).toUpperCase();
    console.log(`[etsyIngest] receipt ${receiptId} created order ${shortId}`);
    await alertAdmin(
      `Etsy order ${receiptId} is in and waiting for review`,
      `Order: ${shortId}\n` +
      `Order ID: ${created.orderId}\n` +
      `Etsy receipt: ${receiptId}\n` +
      `Bought: ${mapped.intake.sku}${mapped.intake.frameChoice ? `, ${mapped.intake.frameChoice} frame` : ''}\n` +
      `For: ${mapped.intake.fields.petName}\n\n` +
      (mapped.warnings.length
        ? `Read these before you print it:\n${mapped.warnings.map(w => `  - ${w}`).join('\n')}\n\n`
        : '') +
      `Write the poem and approve it: ${BASE_URL()}/admin/review/${created.adminToken}`
    );
    return result;
  } catch (err) {
    // createFromMarketplace checks for a duplicate receipt, then awaits the
    // image pipeline, then inserts. Two pulls overlapping in that gap both
    // pass the check and the second one hits the unique index instead, so the
    // duplicate arrives as a raw SQLite error rather than our own code.
    const isDuplicate = err.code === 'DUPLICATE_RECEIPT' || /UNIQUE constraint/i.test(err.message || '');
    if (isDuplicate) {
      result.outcome = 'duplicate';
      result.reason = `Etsy order ${receiptId} is already in the system.`;
      // err.orderId is only set on our own check. A collision at the index
      // carries no id, so look the order up by the receipt instead: either way
      // the caller gets a link to the tribute that already exists.
      const existing = err.orderId
        ? db.get('SELECT id, admin_token FROM orders WHERE id = ?', [err.orderId])
        : db.get('SELECT id, admin_token FROM orders WHERE etsy_receipt_id = ?', [receiptId]);
      if (existing) {
        result.orderId = existing.id;
        result.reviewUrl = `/admin/review/${existing.admin_token}`;
      } else {
        result.orderId = err.orderId || null;
      }
      console.log(`[etsyIngest] receipt ${receiptId} is already in the system, nothing created`);
      return result;
    }

    result.outcome = 'error';
    result.reason = `Etsy order ${receiptId} could not be created: ${err.message}`;
    console.error(`[etsyIngest] receipt ${receiptId} failed to create an order: ${err.message}`);
    await alertAdmin(
      `Etsy order ${receiptId} could not be created`,
      `Etsy receipt: ${receiptId}\n` +
      `Step: creating the order from the mapped receipt\n` +
      `Error: ${err.message}\n\n` +
      `Enter the order by hand: ${BASE_URL()}/admin/intake`
    );
    return result;
  }
}

module.exports = { receiptToIntake, ingestReceipt, REFUSAL };
