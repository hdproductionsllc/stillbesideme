/**
 * Still Beside Me – Tribute lightbox
 * ---------------------------------------------------------------------------
 * The framed tribute images on the homepage and /the-writing are the most
 * persuasive thing on the site, but at gallery size the poem inside them is
 * unreadable. Clicking one opens it larger, with the poem repeated as real,
 * selectable HTML text so it stays crisp and readable on a phone.
 *
 * The poem data below is copied verbatim from the TRIBUTES array in
 * scripts/generate-frame-mockups.js, which is the source of truth for what is
 * printed inside each JPEG. If a poem changes there, change it here too.
 *
 * Vanilla JS, no dependencies, CSP-safe (external /js file, no eval).
 * Deliberately self-contained so it cannot interfere with store.js.
 */
(function () {
  'use strict';

  // Keyed by the tribute's image basename (/images/tributes/<key>.jpg).
  var TRIBUTES = {
  "simba": {
    name: "Simba",
    nickname: "Si",
    birth: "2010",
    pass: "2023",
    family: "the Whitfield family",
    poem: "You held the whole yard in one steady gaze,\nunbothered, unhurried, sure.\n\nKing of the warm stone and the tall grass,\nyou came when you wished\nand stayed when it mattered most.\n\nThe grass still bends where you sat.\nWe still look for you there.",
  },
  "rusty": {
    name: "Rusty",
    nickname: "Rus",
    birth: "2009",
    pass: "2022",
    family: "the Delgado family",
    poem: "You knew the truck three streets away\nand met it at the gate every single time.\n\nOne tennis ball, gone flat and grey,\nwas the finest thing you ever owned—\nyou carried it to bed like treasure.\n\nGood boy on the long trail, good boy at the door.\nThe ball's still on the porch.\nWe couldn't bring ourselves to move it.",
  },
  "biscuit": {
    name: "Biscuit",
    nickname: "Bisky",
    birth: "2013",
    pass: "2025",
    family: "the Callahan family",
    poem: "All paws and hope and headlong joy,\nyou ran at the world like it owed you a game.\n\nYou chewed our shoes and stole our hearts\nand taught us how to greet a morning.\n\nSlow down now, sweet one.\nWe will catch up to you.",
  },
  "pixie": {
    name: "Pixie",
    nickname: "Pix",
    birth: "2011",
    pass: "2024",
    family: "the Romano family",
    poem: "You had one chair—the blue one by the window—\nand you guarded it like it held the sun.\n\nEvery night at ten you found my pillow,\nkneaded it twice, and sighed us both to sleep.\n\nYou never asked for more than that:\na warm knee, a slow hand, the ten o'clock hush.\n\nThe blue chair is still yours.\nWe just sit beside it now.",
  },
  "pippin": {
    name: "Pippin",
    nickname: "Pip",
    birth: "2014",
    pass: "2024",
    family: "the Novak family",
    poem: "Curious to your whiskers,\nyou investigated every shadow,\ntested every lap, trusted every hand.\n\nThe world was a question\nand you were determined to answer it.\n\nWe are still learning\nhow to be brave the way you were.",
  },
  "ziggy": {
    name: "Ziggy",
    nickname: "Zig",
    birth: "2010",
    pass: "2023",
    family: "the Hayes family",
    poem: "You ruled the lemon tree by the fence,\nhalf wild, half ours, up before the birds.\n\nYou'd vanish for the whole gold afternoon\nand turn up at the door at six on the dot,\nleaves in your fur, entirely pleased with yourself.\n\nWherever you've climbed to now,\nwe know there's a warm branch, a low sun,\nand dinner, right on time.",
  },
  "boots": {
    name: "Boots",
    nickname: "Bootsie",
    birth: "2008",
    pass: "2022",
    family: "the Marsh family",
    poem: "You walked the yard like you owned the deed,\nchin up, tail high, unhurried.\n\nYou met us at the gate each evening\nas if our coming home\nwas the finest thing that could happen.\n\nIt was. It still is.\nWe just miss you at the gate.",
  },
  "mittens": {
    name: "Mittens",
    nickname: "Mitts",
    birth: "2007",
    pass: "2021",
    family: "the Ellison family",
    poem: "Fourteen warm years, curled in the sun,\na soft gold comma at the end of our days.\n\nYou taught us the art of resting,\nof taking the good light while it lasts,\nof staying close to the ones you love.\n\nRest easy now, old friend.\nYou earned every quiet hour.",
  },
  "tigger": {
    name: "Tigger",
    nickname: "Tig",
    birth: "2012",
    pass: "2024",
    family: "the Barnes family",
    poem: "Watchful, elegant, entirely in charge,\nyou surveyed your kingdom from the high shelf\nand found it, on the whole, acceptable.\n\nYou let us love you on your terms,\nwhich made every purr a small victory.\n\nThe high shelf is empty now.\nThe kingdom is not the same.",
  },
  "marbles": {
    name: "Marbles",
    nickname: "Marb",
    birth: "2011",
    pass: "2023",
    family: "the Foster family",
    poem: "You slept on my side of the bed,\nhead on the pillow like you paid the mortgage,\nand woke me at six with a paw to the cheek.\n\nOn the hard days you found me first,\npressed your head to mine\nand stayed until the world went quiet.\n\nI still wake at six.\nI still reach across the pillow.",
  },
  "ghost": {
    name: "Ghost",
    nickname: "Ghosty",
    birth: "2013",
    pass: "2025",
    family: "the Park family",
    poem: "Quiet as snowfall, soft as dusk,\nyou appeared where you were needed\nand vanished when the moment passed.\n\nYou chose the good chair, the warm knee,\nthe exact center of every photograph.\n\nYou are still here, somehow—\na small white warmth in the corner of the eye.",
  },
  "callie": {
    name: "Callie",
    nickname: "Cal",
    birth: "2010",
    pass: "2024",
    family: "the Nguyen family",
    poem: "You grew up beside the children,\npatient through every game and costume,\nguardian of the small and the sleepy.\n\nYou were the softest place to fall\nand the first to forgive a stumble.\n\nThe house is bigger without you,\nand so much quieter than we'd like.",
  },
  };

  var TRIGGER_SELECTOR = 'img[data-tribute]';
  var FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  var reduceMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  // -- Collect the triggers on this page ---------------------------------
  // Order follows the DOM. A tribute that appears twice on a page (Callie and
  // Biscuit both do on /the-writing) is only one stop in the sequence, so
  // next/previous never shows the same poem twice in a row.
  var triggers = [];
  var order = [];          // unique tribute keys, in first-appearance order
  var indexOfKey = {};     // key to position in the order array
  var altForKey = {};      // key to alt text borrowed from the first trigger

  function has(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }

  function collect() {
    var nodes = document.querySelectorAll(TRIGGER_SELECTOR);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = (node.getAttribute('data-tribute') || '').trim().toLowerCase();
      if (!key || !has(TRIBUTES, key)) continue;

      if (!has(indexOfKey, key)) {
        indexOfKey[key] = order.length;
        order.push(key);
        altForKey[key] = node.getAttribute('alt') ||
          ('Framed memorial tribute for ' + TRIBUTES[key].name);
      }
      triggers.push(node);
      prepareTrigger(node, key);
    }
  }

  // Images are not focusable and do not fire click from the keyboard, so give
  // each one a button role plus Enter/Space handling.
  function prepareTrigger(node, key) {
    var t = TRIBUTES[key];
    node.classList.add('tl-trigger');
    node.setAttribute('role', 'button');
    node.setAttribute('tabindex', '0');
    node.setAttribute('aria-haspopup', 'dialog');
    node.setAttribute('aria-label', 'Read ' + t.name + '’s tribute poem');
    node.addEventListener('click', function (e) {
      e.preventDefault();
      open(key, node);
    });
    node.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();   // stop Space from scrolling the page
        open(key, node);
      }
    });
  }

  // -- Dialog, built once on first open (never preloads a full-size image) --
  var root = null, dialog = null, imgEl = null, nameEl = null, yearsEl = null,
      poemEl = null, familyEl = null, countEl = null, statusEl = null,
      barEl = null, scrollEl = null, bodyEl = null;
  var current = -1;
  var lastTrigger = null;
  var isOpen = false;
  var prevBodyOverflow = '';
  var prevBodyPadRight = '';
  var closeTimer = null;

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function build() {
    root = el('div', 'tl-root');
    root.id = 'tribute-lightbox';
    root.hidden = true;

    dialog = el('div', 'tl-dialog');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'tl-name');
    dialog.setAttribute('tabindex', '-1');

    var closeBtn = el('button', 'tl-close');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.appendChild(el('span', 'tl-x', '×'));
    closeBtn.addEventListener('click', close);

    scrollEl = el('div', 'tl-scroll');

    var media = el('div', 'tl-media');
    imgEl = document.createElement('img');
    imgEl.className = 'tl-img';
    imgEl.setAttribute('decoding', 'async');
    imgEl.alt = '';
    media.appendChild(imgEl);

    bodyEl = el('div', 'tl-body');
    bodyEl.appendChild(el('p', 'tl-eyebrow', 'The Writing'));
    nameEl = el('h2', 'tl-name');
    nameEl.id = 'tl-name';
    bodyEl.appendChild(nameEl);
    yearsEl = el('p', 'tl-years');
    bodyEl.appendChild(yearsEl);
    poemEl = el('div', 'tl-poem');
    bodyEl.appendChild(poemEl);
    familyEl = el('p', 'tl-family');
    bodyEl.appendChild(familyEl);

    scrollEl.appendChild(media);
    scrollEl.appendChild(bodyEl);

    barEl = el('div', 'tl-bar');
    var prevBtn = el('button', 'tl-nav tl-prev');
    prevBtn.type = 'button';
    prevBtn.setAttribute('aria-label', 'Previous tribute');
    prevBtn.appendChild(el('span', 'tl-arrow', '←'));
    prevBtn.appendChild(el('span', 'tl-navtext', 'Previous'));
    prevBtn.addEventListener('click', function () { step(-1); });

    countEl = el('p', 'tl-count');

    var nextBtn = el('button', 'tl-nav tl-next');
    nextBtn.type = 'button';
    nextBtn.setAttribute('aria-label', 'Next tribute');
    nextBtn.appendChild(el('span', 'tl-navtext', 'Next'));
    nextBtn.appendChild(el('span', 'tl-arrow', '→'));
    nextBtn.addEventListener('click', function () { step(1); });

    barEl.appendChild(prevBtn);
    barEl.appendChild(countEl);
    barEl.appendChild(nextBtn);
    if (order.length < 2) barEl.classList.add('tl-bar-solo');

    statusEl = el('p', 'tl-status');
    statusEl.setAttribute('role', 'status');
    statusEl.setAttribute('aria-live', 'polite');

    dialog.appendChild(closeBtn);
    dialog.appendChild(scrollEl);
    dialog.appendChild(barEl);
    dialog.appendChild(statusEl);
    root.appendChild(dialog);

    // Backdrop click: only when the press starts AND ends on the backdrop, so
    // a text selection dragged out of the poem does not close the dialog.
    var pressedBackdrop = false;
    root.addEventListener('mousedown', function (e) {
      pressedBackdrop = (e.target === root);
    });
    root.addEventListener('click', function (e) {
      if (e.target === root && pressedBackdrop) close();
      pressedBackdrop = false;
    });

    // Keys are handled on the dialog and stopped there. store.js listens for
    // Escape on document to dismiss its exit-intent popup; letting our Escape
    // bubble up would silently mark that popup dismissed for the session.
    dialog.addEventListener('keydown', onKeydown);

    document.body.appendChild(root);
  }

  function onKeydown(e) {
    if (!isOpen) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      e.stopPropagation();
      step(1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      e.stopPropagation();
      step(-1);
    } else if (e.key === 'Tab') {
      trapTab(e);
    }
  }

  function trapTab(e) {
    var items = [];
    var nodes = dialog.querySelectorAll(FOCUSABLE);
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      if (!n.hasAttribute('hidden') && n.offsetParent !== null) items.push(n);
    }
    if (!items.length) {
      e.preventDefault();
      dialog.focus();
      return;
    }
    var first = items[0];
    var last = items[items.length - 1];
    var active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === dialog || !dialog.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Focus can still escape via a browser find-bar or an errant script; pull it
  // back if it lands outside the dialog while we are open.
  function onFocusIn(e) {
    if (isOpen && dialog && !dialog.contains(e.target)) {
      e.stopPropagation();
      dialog.focus();
    }
  }

  // -- Rendering ---------------------------------------------------------
  // Blank lines in poemText are stanza breaks; single newlines are line
  // breaks. Both are preserved exactly, and every line is inserted as a text
  // node so nothing in a poem can ever be parsed as markup.
  function renderPoem(text) {
    while (poemEl.firstChild) poemEl.removeChild(poemEl.firstChild);
    var stanzas = String(text).split(/\n[ \t]*\n/);
    for (var s = 0; s < stanzas.length; s++) {
      var lines = stanzas[s].split('\n');
      var p = el('p', 'tl-stanza');
      for (var l = 0; l < lines.length; l++) {
        if (l > 0) p.appendChild(document.createElement('br'));
        p.appendChild(document.createTextNode(lines[l]));
      }
      poemEl.appendChild(p);
    }
  }

  function show(i) {
    current = ((i % order.length) + order.length) % order.length;
    var key = order[current];
    var t = TRIBUTES[key];

    imgEl.src = '/images/tributes/' + key + '.jpg';
    imgEl.alt = altForKey[key] || ('Framed memorial tribute for ' + t.name);

    nameEl.textContent = t.name;

    var years = '';
    if (t.birth && t.pass) years = t.birth + '–' + t.pass;
    else if (t.pass) years = t.pass;
    else if (t.birth) years = t.birth;
    yearsEl.textContent = years;
    yearsEl.hidden = !years;

    renderPoem(t.poem);

    familyEl.textContent = t.family ? 'For ' + t.family : '';
    familyEl.hidden = !t.family;

    countEl.textContent = (current + 1) + ' of ' + order.length;
    statusEl.textContent = t.name + (years ? ', ' + years : '') + '. Tribute ' +
      (current + 1) + ' of ' + order.length + '.';

    if (scrollEl) scrollEl.scrollTop = 0;
    if (bodyEl) bodyEl.scrollTop = 0;
  }

  function step(delta) {
    if (!isOpen || order.length < 2) return;
    show(current + delta);
  }

  // -- Open / close ------------------------------------------------------
  function open(key, trigger) {
    if (!root) build();
    if (isOpen) { show(indexOfKey[key]); return; }

    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }

    lastTrigger = trigger || document.activeElement;
    isOpen = true;

    show(indexOfKey[key]);

    // Lock the page behind the dialog, compensating for the scrollbar so the
    // layout underneath does not jump sideways.
    var sbw = window.innerWidth - document.documentElement.clientWidth;
    prevBodyOverflow = document.body.style.overflow;
    prevBodyPadRight = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (sbw > 0) {
      var basePad = parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = (basePad + sbw) + 'px';
    }
    document.body.classList.add('tl-open');

    root.hidden = false;
    document.addEventListener('focusin', onFocusIn, true);

    // Force a reflow so the opening transition actually runs.
    void root.offsetWidth;
    root.classList.add('is-open');

    dialog.focus();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;

    document.removeEventListener('focusin', onFocusIn, true);
    root.classList.remove('is-open');
    document.body.classList.remove('tl-open');
    document.body.style.overflow = prevBodyOverflow;
    document.body.style.paddingRight = prevBodyPadRight;

    var finish = function () {
      closeTimer = null;
      if (isOpen) return;               // reopened during the fade-out
      root.hidden = true;
      imgEl.removeAttribute('src');     // let the browser release the big JPEG
      imgEl.alt = '';
    };

    if (reduceMotion.matches) finish();
    else closeTimer = setTimeout(finish, 220);

    if (lastTrigger && document.contains(lastTrigger)) {
      try { lastTrigger.focus(); } catch (err) { /* element went away */ }
    }
    lastTrigger = null;
  }

  function init() {
    collect();
    if (!triggers.length) return;
    // Exposed for debugging and for any future in-page "read the poem" link.
    window.SBMTributeLightbox = {
      open: function (key) {
        key = String(key || '').toLowerCase();
        if (has(indexOfKey, key)) open(key, null);
      },
      close: close
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
