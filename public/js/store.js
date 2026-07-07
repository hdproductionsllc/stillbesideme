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
  async function submitEmail(email, formEl) {
    try {
      const res = await fetch('/api/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Handle all signup forms (footer + popup)
  document.querySelectorAll('[data-signup-form], #popup-signup-form').forEach(form => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input[type="email"]');
      const btn = form.querySelector('button');
      const email = input.value.trim();
      if (!email) return;

      btn.disabled = true;
      btn.textContent = 'Sending...';
      const ok = await submitEmail(email);

      if (ok) {
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
      let hasEngaged = false;

      // Wait for real engagement before arming exit-intent
      // (prevents popup on initial page load when cursor is near top)
      document.addEventListener('mousemove', () => { hasEngaged = true; }, { once: true });

      document.addEventListener('mouseout', (e) => {
        if (shown || !hasEngaged) return;
        if (e.clientY < 5 && e.relatedTarget === null) {
          shown = true;
          popup.classList.add('active');
        }
      });

      // Mobile fallback: show after 45 seconds of engagement
      setTimeout(() => {
        if (!shown && !sessionStorage.getItem('sbm_popup_dismissed')) {
          shown = true;
          popup.classList.add('active');
        }
      }, 45000);
    }
  }

  // ============================================================
  // GA4 E-commerce Events
  // ============================================================
  // Track "Create a Tribute" CTA clicks as begin_checkout
  document.querySelectorAll('a[href*="/customize"]').forEach(link => {
    link.addEventListener('click', () => {
      if (typeof gtag === 'function') {
        gtag('event', 'begin_checkout', {
          currency: 'USD',
          value: 119.00,
        });
      }
      // Meta Pixel (only when the pixel is live via /js/env.js)
      if (typeof fbq === 'function' && window.SBM_ENV && window.SBM_ENV.metaPixelId) {
        fbq('track', 'InitiateCheckout');
      }
    });
  });

  // NOTE: the purchase event fires from order-confirmed.html (inline script,
  // deduped per order with the real order total). Do not add it here.

})();
