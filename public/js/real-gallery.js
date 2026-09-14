/**
 * Real customer pieces in the homepage gallery.
 *
 * The pieces committed under /images/tributes/ are demonstrations, rendered
 * from invented pets. The pieces this file inserts are tributes we actually
 * made and shipped, read from GET /api/gallery.
 *
 * They are fetched rather than committed on purpose. Terms of Service section 5
 * promises a customer that we will take their piece down if they ask, and a
 * JPEG or a poem committed to a public repository cannot be taken down: it
 * stays in git history, in every fork and every clone, forever. Held as data,
 * a takedown is one UPDATE. See migration 014.
 *
 * Real work goes FIRST in the grid. It is the most persuasive thing on the
 * page, and burying it under six demonstrations would waste it.
 *
 * Everything is gated on a successful fetch with at least one piece. If the API
 * is down, slow, or empty, the page keeps the gallery it shipped with, which is
 * a correct page. Nothing here removes or rewrites an existing piece.
 *
 * Vanilla JS, no dependencies, CSP-safe (external /js file, no inline, no eval).
 */
(function () {
  'use strict';

  var GALLERY = '.tw-gallery';

  // Aspect of the committed gallery pieces (1100x952). Used only for the
  // width/height hint that reserves space before the image loads; the CSS sizes
  // these by width, so a landscape 16x20 being a half percent off is invisible
  // and still prevents the layout shift.
  var HINT_W = 1100;
  var HINT_H = 952;

  function el(tag, cls) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
  }

  /**
   * One gallery figure. Built with DOM calls rather than innerHTML so that a
   * poem, a pet's name, or anything else coming back from the API is inserted
   * as text or as an attribute value and can never be parsed as markup.
   */
  function figureFor(piece) {
    var fig = el('figure', 'tw-piece');
    var img = el('img');
    img.src = piece.src;
    img.alt = piece.alt || ('Framed memorial tribute for ' + piece.name);
    img.setAttribute('data-tribute', piece.slug);
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.setAttribute('width', HINT_W);
    img.setAttribute('height', HINT_H);
    fig.appendChild(img);
    return fig;
  }

  function insert(gallery, pieces) {
    var frag = document.createDocumentFragment();
    var entries = {};

    for (var i = 0; i < pieces.length; i++) {
      var p = pieces[i];
      if (!p || !p.slug || !p.src || !p.name || !p.poem) continue;
      // A real slug must not collide with a committed demo key, or the
      // lightbox would show one piece's poem beside another's photograph.
      if (document.querySelector('img[data-tribute="' + p.slug + '"]')) continue;

      frag.appendChild(figureFor(p));
      entries[p.slug] = {
        name: p.name,
        years: p.years || '',
        poem: p.poem,
        src: p.src
      };
    }

    if (!frag.childNodes.length) return;
    gallery.insertBefore(frag, gallery.firstChild);

    // Wire the new images into the lightbox. It exposes register() from its own
    // init, which runs on DOMContentLoaded; this fetch resolves later, so it is
    // there. If it somehow is not, the images still render and simply do not
    // open, which is a degraded gallery rather than a broken one.
    var lb = window.SBMTributeLightbox;
    if (lb && typeof lb.register === 'function') lb.register(entries);
  }

  function start() {
    var gallery = document.querySelector(GALLERY);
    if (!gallery) return;

    fetch('/api/gallery')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.pieces || !data.pieces.length) return;
        insert(gallery, data.pieces);
      })
      .catch(function () { /* the gallery is fine without it */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
