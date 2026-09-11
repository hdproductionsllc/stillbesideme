/**
 * Store.js – Scroll animations, email capture, analytics events.
 */

(function () {
  'use strict';

  // ============================================================
  // Scroll-triggered fade-in animations via IntersectionObserver
  // ============================================================
  const fadeEls = document.querySelectorAll('.fade-in');
  if (fadeEls.length > 0 && 'IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

    fadeEls.forEach(el => observer.observe(el));
  } else {
    fadeEls.forEach(el => el.classList.add('visible'));
  }

  // ============================================================
  // Email signup (popup + footer forms)
  // ============================================================
  // `source` is carried through so the server knows what was promised. The poem
  // offer blocks send a source beginning with "poems", which is what makes the
  // server actually email the poems back rather than just filing the address.
  async function submitEmail(email, source) {
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(source ? { email, source } : { email }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * A captured email is a conversion and was reported to nobody.
   *
   * Email capture is the highest-volume thing that happens on the marketing
   * pages, and neither GA4 nor Meta heard about it — so the one step between
   * "read a blog post" and "build a tribute" was invisible in every funnel
   * report, and there was no audience to build from. Fires only on a
   * confirmed 2xx from /api/subscribe, so a failed signup never counts.
   */
  function trackLead(source) {
    try {
      if (typeof gtag === 'function') {
        gtag('event', 'generate_lead', { method: source || 'signup' });
      }
      const env = window.SBM_ENV || {};
      if (env.metaPixelId && typeof fbq === 'function') {
        fbq('track', 'Lead', { content_name: source || 'signup' });
      }
    } catch (e) {
      // Never let analytics break a signup that already succeeded.
    }
  }

  // Handle all signup forms (footer + popup + inline offers)
  document.querySelectorAll('[data-signup-form], #popup-signup-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input[type="email"]');
      const btn = form.querySelector('button');
      const email = input.value.trim();
      if (!email) return;

      btn.disabled = true;
      btn.textContent = 'Sending...';
      const ok = await submitEmail(email, form.dataset.source);

      if (ok) {
        trackLead(form.dataset.source);
        // An inline offer declares its own confirmation, so the reader is told
        // the poems are on their way rather than just seeing a button change.
        const inlineSuccess = form.parentElement
          && form.parentElement.querySelector('[data-signup-success]');
        if (inlineSuccess) {
          form.hidden = true;
          inlineSuccess.hidden = false;
          document.cookie = 'sbm_subscribed=1;max-age=31536000;path=/;SameSite=Lax';
          return;
        }

        // Show success
        const successEl = form.closest('.email-popup')
          ? form.closest('.email-popup').querySelector('.email-popup-success')
          : null;
        if (successEl) {
          form.style.display = 'none';
          successEl.style.display = 'block';
          // Set cookie so popup doesn't reappear
          document.cookie = 'sbm_subscribed=1;max-age=31536000;path=/;SameSite=Lax';
          setTimeout(() => closePopup(), 2500);
        } else {
          input.value = '';
          btn.textContent = 'Subscribed!';
          btn.disabled = true;
          document.cookie = 'sbm_subscribed=1;max-age=31536000;path=/;SameSite=Lax';
        }
      } else {
        btn.textContent = 'Try again';
        btn.disabled = false;
      }
    });
  });

  // ============================================================
  // Exit-intent popup
  // ============================================================
  const popup = document.getElementById('email-popup');

  function closePopup() {
    if (popup) {
      popup.classList.remove('active');
      // Don't show again this session
      sessionStorage.setItem('sbm_popup_dismissed', '1');
    }
  }

  if (popup) {
    // Close button
    const closeBtn = popup.querySelector('.email-popup-close');
    if (closeBtn) closeBtn.addEventListener('click', closePopup);

    // Click outside to close
    popup.addEventListener('click', (e) => {
      if (e.target === popup) closePopup();
    });

    // Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePopup();
    });

    // Show on exit intent (mouse leaves viewport top) — desktop only
    const alreadySubscribed = document.cookie.includes('sbm_subscribed=1');
    const alreadyDismissed = sessionStorage.getItem('sbm_popup_dismissed');

    if (!alreadySubscribed && !alreadyDismissed) {
      let shown = false;

      const show = () => {
        if (shown || sessionStorage.getItem('sbm_popup_dismissed')) return;
        shown = true;
        popup.classList.add('active');
      };

      // The popup only appears once someone has genuinely engaged with the
      // page — never on arrival. "Engaged" means BOTH a real dwell (30s) AND
      // meaningful scrolling (past ~40% of the page). This is a grief brand;
      // nothing should ambush a visitor who just landed.
      let dwelled = false;
      let scrolled = false;
      let armed = false;

      const arm = () => {
        if (armed || !(dwelled && scrolled)) return;
        armed = true;

        // Desktop: fire on true exit intent (cursor leaves the top edge toward
        // the tab/close). Requires the mouse to actually cross clientY <= 0.
        document.addEventListener('mouseout', (e) => {
          if (e.clientY <= 0 && e.relatedTarget === null) show();
        });

        // Touch/no-mouse: there is no exit intent, so surface it gently a short
        // while after they've already engaged, not on a fixed page-load timer.
        if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
          setTimeout(show, 8000);
        }
      };

      setTimeout(() => { dwelled = true; arm(); }, 30000);
      window.addEventListener('scroll', () => {
        const depth = (window.scrollY + window.innerHeight) / document.documentElement.scrollHeight;
        if (depth > 0.4) { scrolled = true; arm(); }
      }, { passive: true });
    }
  }

  // ============================================================
  // GA4 E-commerce Events
  // ============================================================
  // Track "Create a Tribute" CTA clicks as top-of-funnel intent only.
  // The real begin_checkout / InitiateCheckout fires from the customizer's
  // purchase button with the true order value (customizer.js) — firing it
  // here too would double-count the funnel and stamp it with a made-up value.
  document.querySelectorAll('a[href*="/customize"]').forEach(link => {
    link.addEventListener('click', () => {
      if (typeof gtag === 'function') {
        gtag('event', 'customize_cta_click');
      }
    });
  });

  // ============================================================
  // view_item on the product pages.
  //
  // Without it the funnel jumps straight from page_view to a builder start,
  // so neither platform can tell a visitor who looked at the product from one
  // who read a blog post and left — and there is no product-view audience to
  // remarket to. Driven by the Product JSON-LD that is already on the page
  // (homepage only, since the landing pages intentionally no longer duplicate
  // the Product entity), so the price here can never drift from the price we
  // publish to Google.
  (function trackViewItem() {
    try {
      const blocks = document.querySelectorAll('script[type="application/ld+json"]');
      if (!blocks.length) return;
      let product = null;
      blocks.forEach(b => {
        if (product) return;
        try {
          const parsed = JSON.parse(b.textContent);
          if (parsed && parsed['@type'] === 'Product') product = parsed;
        } catch (e) { /* not this block */ }
      });
      if (!product) return;

      const offers = Array.isArray(product.offers) ? product.offers : [product.offers];
      const primary = offers.find(o => o && o['@type'] === 'Offer') || {};
      const value = Number(primary.price) || 0;

      if (typeof gtag === 'function') {
        gtag('event', 'view_item', {
          currency: 'USD',
          value: value,
          items: [{
            item_id: product.sku || 'pet-tribute',
            item_name: product.name || 'Pet Tribute',
            price: value,
            quantity: 1,
          }],
        });
      }
      const env = window.SBM_ENV || {};
      if (env.metaPixelId && typeof fbq === 'function') {
        fbq('track', 'ViewContent', {
          content_type: 'product',
          content_ids: [product.sku || 'pet-tribute'],
          value: value,
          currency: 'USD',
        });
      }
    } catch (e) {
      // A page with no product schema simply reports nothing.
    }
  })();

  // NOTE: the purchase event fires from order-confirmed.html (inline script,
  // deduped per order with the real order total). Do not add it here.

})();
