/**
 * Real star ratings, and only real ones.
 *
 * Reads GET /api/reviews, whose figures combine two real sources: the legacy 30
 * customers (148 points across 30 ratings, recorded in src/data/reviews.json)
 * and every published row of the customer_reviews table. The legacy quotes
 * still carry no per-person reviewRating, because the mapping from score to
 * person was not kept, and inventing one is not an option.
 *
 * Three jobs:
 *
 * 1. Refresh any [data-customer-rating] element with the current figure.
 * 2. Fill any [data-customer-reviews] container with the new published reviews.
 * 3. Attach an AggregateRating to the page's Product JSON-LD.
 *
 * The pages already ship a correct static baseline, written into the HTML by
 * npm run review-aggregate, so a reader with JavaScript switched off and a
 * crawler that never runs it both see the true figure. This script exists to
 * close the gap between that baseline and reality as new reviews are published,
 * so nobody has to remember to re-run a build script for the number to stay
 * honest.
 *
 * Everything is hard-gated on count >= 1. If the rating data ever disappears
 * the correct output is to leave the page alone, not to write a zero.
 *
 * FTC Rule on Consumer Reviews (2024): a review left by someone who got the
 * product free or discounted must say so wherever it is shown. The API sends
 * that flag with every review and the label below is not optional.
 */
(function () {
  'use strict';

  var INCENTIVISED_LABEL = 'Received a complimentary piece';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function starsFor(rating) {
    var n = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
    return '★'.repeat(n) + '☆'.repeat(5 - n);
  }

  /**
   * Put the aggregate on the Product node the page already publishes. Google
   * needs it attached to the product, not floating on its own, so this edits
   * the existing graph rather than adding a second, competing one.
   */
  function attachAggregate(aggregate) {
    var blocks = document.querySelectorAll('script[type="application/ld+json"]');
    for (var i = 0; i < blocks.length; i++) {
      var parsed;
      try {
        parsed = JSON.parse(blocks[i].textContent);
      } catch (e) {
        continue;
      }
      // A page may hold a single node, an array of nodes, or a @graph.
      var nodes = Array.isArray(parsed) ? parsed : (parsed['@graph'] || [parsed]);
      var touched = false;
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j] && nodes[j]['@type'] === 'Product') {
          nodes[j].aggregateRating = aggregate;
          touched = true;
        }
      }
      if (touched) {
        blocks[i].textContent = JSON.stringify(parsed);
        return true;
      }
    }
    return false;
  }

  /** The visible figure, kept identical in wording to the static baseline. */
  function renderRating(el, data) {
    el.innerHTML = '<span class="cr-stars" aria-hidden="true">' + starsFor(data.mean) + '</span>'
      + '<span class="cr-score">' + esc(data.ratingValue) + ' out of 5</span>'
      + '<span class="cr-count">from ' + data.count + ' review'
      + (data.count === 1 ? '' : 's') + '</span>';
  }

  function renderInto(el, data) {
    var header = '<div class="cr-summary">'
      + '<span class="cr-stars" aria-hidden="true">' + starsFor(data.mean) + '</span> '
      + '<span class="cr-score">' + esc(data.ratingValue) + ' out of 5</span> '
      + '<span class="cr-count">from ' + data.count + ' review'
      + (data.count === 1 ? '' : 's') + '</span>'
      + '</div>';

    var items = data.reviews.map(function (r) {
      return '<li class="cr-item">'
        + '<span class="cr-stars" aria-hidden="true">' + starsFor(r.rating) + '</span>'
        + '<span class="cr-sr">' + r.rating + ' out of 5</span>'
        + '<p class="cr-body">' + esc(r.body) + '</p>'
        + '<p class="cr-attrib">' + esc(r.author)
        + (r.incentivised
            ? ' <span class="cr-disclosure">' + INCENTIVISED_LABEL + '</span>'
            : '')
        + '</p>'
        + '</li>';
    }).join('');

    el.innerHTML = header + '<ul class="cr-list">' + items + '</ul>';
    el.hidden = false;
  }

  function start() {
    var slots = document.querySelectorAll('[data-customer-reviews]');
    var ratings = document.querySelectorAll('[data-customer-rating]');
    var jsonLd = document.querySelector('script[type="application/ld+json"]');
    if (!slots.length && !ratings.length && !jsonLd) return;

    fetch('/api/reviews')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        // No rating data at all means nothing to say. Leave the page alone,
        // including whatever correct baseline is already in the HTML.
        if (!data || !data.count || !data.aggregateRating) return;

        attachAggregate(data.aggregateRating);
        var i;
        for (i = 0; i < ratings.length; i++) renderRating(ratings[i], data);
        // Only the new reviews get rendered as cards. The legacy quotes are
        // already on the page, so re-adding them would show them twice.
        if (data.reviews && data.reviews.length) {
          for (i = 0; i < slots.length; i++) renderInto(slots[i], data);
        }
      })
      .catch(function () { /* the page is fine without it */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
