/**
 * The Etsy receipt mapper, tested against receipts that do not exist yet.
 *
 * There have been no Etsy sales. Etsy will not let a seller buy from their own
 * shop, so nobody in this business has ever seen a real ShopReceipt for this
 * listing, and the mapper in src/services/etsyIngest.js was written from the
 * API documentation and the listing we published. Every fixture below is
 * therefore invented, and that is the whole reason this file matters: the
 * fixtures are the specification, and they say out loud what shape we are
 * assuming. When the first real receipt lands it gets stored under the
 * 'etsy.meta' setting, and whoever reads it should come straight here and make
 * these match reality.
 *
 * What is being defended is not tidiness. A wrong size or a wrong frame is a
 * reprint and another week of waiting for someone whose dog just died, so the
 * mapper is built to refuse rather than guess, and most of the cases below are
 * checks that it really does refuse.
 *
 * Pure: no database, no network, no server.
 *
 *   node tests/etsy-mapper.js
 */

const assert = require('assert');
const path = require('path');

const { receiptToIntake, REFUSAL } = require('../src/services/etsyIngest');
const template = require(path.join(__dirname, '..', 'src', 'data', 'templates', 'pet-tribute.json'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// ─── Fixture builders ────────────────────────────────────────────────

const ABOUT = 'She met me at the door every single day for twelve years, even the last one.';
const PHOTO_URL = 'https://i.etsystatic.com/12345678/r/il/abc123/4444444444/il_fullxfull.4444444444_9xyz.jpg';

/** A personalization answer: question_id is what marks it as one. */
function answer(id, name, value) {
  return {
    property_id: 500 + id,
    value_id: null,
    formatted_name: name,
    formatted_value: value,
    question_id: 9000 + id,
  };
}

/** A product variation: question_id is null on every one of these. */
function option(name, value) {
  return {
    property_id: name === 'Size' ? 100 : 200,
    value_id: 1,
    formatted_name: name,
    formatted_value: value,
    question_id: null,
  };
}

/** The five answers the live listing asks for, in the order it asks them. */
function fiveAnswers({ petName = 'Bailee', years = '2014 - 2026', about = ABOUT,
  poem = 'Write it for me', photo = PHOTO_URL } = {}) {
  return [
    answer(1, "Pet's name", petName),
    answer(2, 'Years (optional)', years),
    answer(3, 'Tell us about them', about),
    answer(4, 'Poem: write it for me, or use my own words', poem),
    answer(5, 'Photo upload', photo),
  ];
}

function transaction({ variations, quantity = 1, sku = '' } = {}) {
  return {
    transaction_id: 77771111,
    listing_id: 4575127270,
    sku,
    quantity,
    price: { amount: 11900, divisor: 100, currency_code: 'USD' },
    variations: variations || [
      option('Size', '11x14'),
      option('Frame', 'Black'),
      ...fiveAnswers(),
    ],
  };
}

function receipt(overrides = {}) {
  return {
    receipt_id: 3001234567,
    name: 'Maria Gonzalez',
    first_line: '742 Evergreen Terrace',
    second_line: 'Apt 4',
    city: 'Springfield',
    state: 'OR',
    zip: '97477',
    country_iso: 'US',
    status: 'Paid',
    is_paid: true,
    is_shipped: false,
    is_gift: false,
    gift_message: '',
    message_from_buyer: 'Her name is spelled Bailee, not Bailey.',
    grandtotal: { amount: 11900, divisor: 100, currency_code: 'USD' },
    transactions: [transaction()],
    ...overrides,
  };
}

/** Build a receipt whose single transaction carries exactly these variations. */
function receiptWith(variations, extra = {}) {
  return receipt({ transactions: [transaction({ variations })], ...extra });
}

function refusalCode(result) {
  assert.strictEqual(result.ok, false, `expected a refusal, got ok:${result.ok}`);
  return result.code;
}

console.log('\nEtsy receipt mapper\n');

// ─── The one that has to be exactly right ────────────────────────────

check('the happy path maps to the exact order we would create by hand', () => {
  const result = receiptToIntake(receipt(), template);
  assert.strictEqual(result.ok, true, result.ok ? '' : `refused: ${result.reason}`);

  assert.deepStrictEqual(result.intake, {
    source: 'etsy',
    etsyReceiptId: '3001234567',
    templateId: 'pet-tribute',
    sku: 'framed-11x14',
    fields: {
      petName: 'Bailee',
      birthDate: '2014',
      passDate: '2026',
      favoriteMemory: ABOUT,
    },
    shipping: {
      name: 'Maria Gonzalez',
      address1: '742 Evergreen Terrace',
      address2: 'Apt 4',
      city: 'Springfield',
      state: 'OR',
      zip: '97477',
      country: 'US',
    },
    notes:
      'Etsy receipt 3001234567.\n\n' +
      `What the buyer told us about them, in their own words:\n${ABOUT}\n\n` +
      'Message from the buyer at checkout:\nHer name is spelled Bailee, not Bailey.',
    frameChoice: 'black',
    totalCents: 11900,
  });

  assert.deepStrictEqual(result.photoUrls, [PHOTO_URL]);
});

check('the address uses address1/address2, the spelling everything downstream reads', () => {
  const result = receiptToIntake(receipt(), template);
  assert.ok(!('line1' in result.intake.shipping), 'line1 would ship a parcel with no street');
  assert.strictEqual(result.intake.shipping.address1, '742 Evergreen Terrace');
});

check('grandtotal is read as a Money object, not as a number', () => {
  const result = receiptToIntake(receipt(), template);
  assert.strictEqual(result.intake.totalCents, 11900, 'a raw amount read as cents would be 100x the price');
});

check('the missing pet type is called out every time, because Etsy never asks', () => {
  const result = receiptToIntake(receipt(), template);
  assert.ok(result.warnings.some(w => /kind of pet/i.test(w)), `warnings were: ${JSON.stringify(result.warnings)}`);
  assert.strictEqual(result.warnings.length, 1, `a clean order should carry one warning, got ${JSON.stringify(result.warnings)}`);
});

// ─── The buyer's own words ───────────────────────────────────────────

check('"I have my own words" becomes the poem, not a memory to write from', () => {
  const result = receiptToIntake(
    receiptWith([option('Size', '11x14'), option('Frame', 'Black'),
      ...fiveAnswers({ poem: 'I have my own words' })]), template);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.intake.ownPoem, ABOUT);
  assert.strictEqual(result.intake.fields.favoriteMemory, undefined,
    'their poem must not also be fed to the poem writer as raw material');
  assert.ok(result.intake.notes.includes(ABOUT), 'the verbatim text must survive on the order notes either way');
});

check('a years answer with no dash is a birth date and nothing else', () => {
  const result = receiptToIntake(
    receiptWith([option('Size', '11x14'), option('Frame', 'Black'),
      ...fiveAnswers({ years: '2015' })]), template);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.intake.fields.birthDate, '2015');
  assert.strictEqual(result.intake.fields.passDate, undefined, 'an invented pass date would be printed on the piece');
});

check('an en dash splits the years the same as a hyphen', () => {
  const result = receiptToIntake(
    receiptWith([option('Size', '11x14'), option('Frame', 'Black'),
      ...fiveAnswers({ years: '2011 – 2024' })]), template);
  assert.strictEqual(result.intake.fields.birthDate, '2011');
  assert.strictEqual(result.intake.fields.passDate, '2024');
});

// ─── Reading answers by name, never by position ──────────────────────

check('answers in a shuffled order still land in the right fields', () => {
  const [name, years, about, poem, photo] = fiveAnswers();
  const result = receiptToIntake(
    receiptWith([photo, option('Frame', 'Black'), poem, about, option('Size', '11x14'), years, name]), template);
  assert.strictEqual(result.ok, true, result.ok ? '' : `refused: ${result.reason}`);
  assert.strictEqual(result.intake.fields.petName, 'Bailee');
  assert.strictEqual(result.intake.fields.favoriteMemory, ABOUT);
  assert.deepStrictEqual(result.photoUrls, [PHOTO_URL]);
});

check('an unanswered optional question does not shift every answer after it', () => {
  const [name, , about, poem, photo] = fiveAnswers();
  const result = receiptToIntake(
    receiptWith([option('Size', '11x14'), option('Frame', 'Black'), name, about, poem, photo]), template);
  assert.strictEqual(result.ok, true, result.ok ? '' : `refused: ${result.reason}`);
  assert.strictEqual(result.intake.fields.petName, 'Bailee', 'read by position this would be the life dates');
  assert.strictEqual(result.intake.fields.birthDate, undefined);
  assert.strictEqual(result.intake.fields.favoriteMemory, ABOUT);
});

check('three photo URLs crammed into one answer all come through', () => {
  const three = [PHOTO_URL, PHOTO_URL.replace('4444', '5555'), PHOTO_URL.replace('4444', '6666')];
  const result = receiptToIntake(
    receiptWith([option('Size', '11x14'), option('Frame', 'Black'),
      ...fiveAnswers({ photo: three.join('\n') })]), template);
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.photoUrls, three);
});

check('a fourth photo is dropped, loudly, because only three are ever printed', () => {
  const four = ['4444', '5555', '6666', '7777'].map(n => PHOTO_URL.replace('4444', n));
  const result = receiptToIntake(
    receiptWith([option('Size', '11x14'), option('Frame', 'Black'),
      ...fiveAnswers({ photo: four.join(' ') })]), template);
  assert.strictEqual(result.photoUrls.length, 3);
  assert.ok(result.warnings.some(w => /4 photos/.test(w)), `warnings were: ${JSON.stringify(result.warnings)}`);
});

// ─── The refusals ────────────────────────────────────────────────────

check('two items on one receipt are refused, not half created', () => {
  const r = receipt({ transactions: [transaction(), transaction()] });
  assert.strictEqual(refusalCode(receiptToIntake(r, template)), 'MULTI_TRANSACTION');
});

check('a quantity of two is refused, because the printer is only ever told to make one', () => {
  const r = receipt({ transactions: [transaction({ quantity: 2 })] });
  assert.strictEqual(refusalCode(receiptToIntake(r, template)), 'QUANTITY');
});

check('a size we do not sell is refused rather than defaulted to 11x14', () => {
  const r = receiptWith([option('Size', 'Large'), option('Frame', 'Black'), ...fiveAnswers()]);
  assert.strictEqual(refusalCode(receiptToIntake(r, template)), 'UNKNOWN_SIZE');
});

check('an inch mark in the size option does not refuse the order', () => {
  // The likeliest spelling of the likeliest option. \s* will not cross a quote
  // character, so before the quote stripping every one of these refused, and a
  // shop selling nothing but 11x14 would have had every order retyped by hand.
  for (const spelling of ['11" x 14"', '11” x 14”', '11" x 14" inches', '11″x14″']) {
    const r = receiptWith([option('Size', spelling), option('Frame', 'Black'), ...fiveAnswers()]);
    const out = receiptToIntake(r, template);
    // Do not call refusalCode here: it asserts a refusal, so building the
    // message eagerly would throw before the real assertion ran.
    assert.strictEqual(out.ok, true, `${spelling} should map, got ${out.code || 'no code'}`);
    assert.strictEqual(out.intake.sku, 'framed-11x14');
  }
});

check('a receipt with no currency code is refused, not read as dollars', () => {
  const r = receiptWith([option('Size', '11x14'), option('Frame', 'Black'), ...fiveAnswers()]);
  r.grandtotal = { amount: 11900, divisor: 100 };
  assert.strictEqual(refusalCode(receiptToIntake(r, template)), 'BAD_CURRENCY');
});

check('a size that parses but is not a product is still refused', () => {
  const r = receiptWith([option('Size', '18x24'), option('Frame', 'Black'), ...fiveAnswers()]);
  assert.strictEqual(refusalCode(receiptToIntake(r, template)), 'UNKNOWN_SIZE');
});

check('a frame we do not stock is refused rather than quietly turned black', () => {
  const r = receiptWith([option('Size', '11x14'), option('Frame', 'Rose Gold'), ...fiveAnswers()]);
  assert.strictEqual(refusalCode(receiptToIntake(r, template)), 'UNKNOWN_FRAME');
});

check('a frame label we do stock resolves to its id, not its label', () => {
  const r = receiptWith([option('Size', '11x14'), option('Frame', 'Natural Wood'), ...fiveAnswers()]);
  const result = receiptToIntake(r, template);
  assert.strictEqual(result.intake.frameChoice, 'oak',
    'orderIntake.resolveFrame must receive an id it already knows, or its silent black fallback can fire');
});

check('a signature frame on an 8x10 is refused, because we do not offer it that small', () => {
  const r = receiptWith([option('Size', '8x10'), option('Frame', 'Driftwood Gray'), ...fiveAnswers()]);
  assert.strictEqual(refusalCode(receiptToIntake(r, template)), 'FRAME_TOO_SMALL');
});

check('the same signature frame on a 16x20 is fine', () => {
  const r = receiptWith([option('Size', '16x20'), option('Frame', 'Driftwood Gray'), ...fiveAnswers()]);
  const result = receiptToIntake(r, template);
  assert.strictEqual(result.ok, true, result.ok ? '' : `refused: ${result.reason}`);
  assert.strictEqual(result.intake.sku, 'framed-16x20');
  assert.strictEqual(result.intake.frameChoice, 'driftwood');
});

check('no photo means no order, because there is nothing to print', () => {
  const r = receiptWith([option('Size', '11x14'), option('Frame', 'Black'),
    ...fiveAnswers({ photo: '' })]);
  assert.strictEqual(refusalCode(receiptToIntake(r, template)), 'NO_PHOTOS');
});

check('a blank pet name is refused, because the name is printed on the piece', () => {
  const r = receiptWith([option('Size', '11x14'), option('Frame', 'Black'),
    ...fiveAnswers({ petName: '   ' })]);
  assert.strictEqual(refusalCode(receiptToIntake(r, template)), 'NO_PET_NAME');
});

check('a non-USD total is refused rather than recorded as the wrong number', () => {
  const r = receipt({ grandtotal: { amount: 11900, divisor: 100, currency_code: 'CAD' } });
  assert.strictEqual(refusalCode(receiptToIntake(r, template)), 'BAD_CURRENCY');
});

check('an unpaid receipt is refused even though the list call filtered for paid ones', () => {
  const r = receipt({ is_paid: false, status: 'Open' });
  assert.strictEqual(refusalCode(receiptToIntake(r, template)), 'NOT_PAID');
});

check('a canceled receipt is refused', () => {
  const r = receipt({ status: 'Canceled' });
  assert.strictEqual(refusalCode(receiptToIntake(r, template)), 'CANCELED');
});

// ─── The things worth saying out loud ────────────────────────────────

check('a gift order warns that it will be built as a self order', () => {
  const result = receiptToIntake(receipt({ is_gift: true, gift_message: 'Thinking of you, Sarah.' }), template);
  assert.strictEqual(result.ok, true);
  assert.ok(result.warnings.some(w => /gift/i.test(w)), `warnings were: ${JSON.stringify(result.warnings)}`);
  assert.ok(result.intake.notes.includes('Thinking of you, Sarah.'), 'the gift message must reach the order record');
});

check('an order shipping outside the US warns before it reaches the printer', () => {
  const result = receiptToIntake(receipt({ country_iso: 'CA' }), template);
  assert.strictEqual(result.ok, true);
  assert.ok(result.warnings.some(w => /ships to CA/.test(w)), `warnings were: ${JSON.stringify(result.warnings)}`);
});

check('our own SKU on the listing is trusted before the size option is parsed', () => {
  const r = receipt({ transactions: [transaction({ sku: 'framed-16x20',
    variations: [option('Size', 'anything at all'), option('Frame', 'Black'), ...fiveAnswers()] })] });
  const result = receiptToIntake(r, template);
  assert.strictEqual(result.ok, true, result.ok ? '' : `refused: ${result.reason}`);
  assert.strictEqual(result.intake.sku, 'framed-16x20');
});

// ─── The refusal sentences themselves ────────────────────────────────

check('every refusal tells a human where to go next', () => {
  for (const [code, sentence] of Object.entries(REFUSAL)) {
    assert.ok(/\/admin\/intake/.test(sentence), `${code} does not say what to do next`);
    assert.ok(!/[—]/.test(sentence), `${code} contains an em dash, which is banned in copy`);
  }
});

check('REFUSAL cannot be edited at runtime', () => {
  assert.ok(Object.isFrozen(REFUSAL));
});

console.log(failures ? `\n${failures} failure(s)\n` : '\nAll good.\n');
process.exit(failures ? 1 : 0);
