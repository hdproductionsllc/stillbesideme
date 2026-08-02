/**
 * Customizer.js – Multi-template guided emotional flow.
 *
 * Reads the template ID from the URL path (/customize/letter-from-heaven),
 * defaulting to 'pet-tribute' when no template slug is present.
 * Everything – form fields, poem labels, gift toggle, generate button –
 * is driven by the template definition.
 *
 * Manages the form pane, layout/style selectors, photo crop interactions,
 * draggable divider handles between panels, and optional third panel.
 */

(function () {
  'use strict';

  const formPane = document.getElementById('form-pane');
  if (!formPane) return;

  // ── Template ID from URL ──────────────────────────────────
  const pathParts = window.location.pathname.split('/').filter(Boolean);
  // /customize/letter-from-heaven → ['customize', 'letter-from-heaven']
  const TEMPLATE_ID = pathParts.length > 1 ? pathParts[pathParts.length - 1] : 'pet-tribute';
  const SESSION_KEY = `sbm-customizer-${TEMPLATE_ID}`;

  const MAX_REGENERATIONS = 3;
  const MIN_FR = 0.3;        // minimum fr value when dragging dividers

  let template = null;
  let poems = [];
  // Generated tribute text is tracked PER FORMAT (poem vs letter): each format
  // owns its own version history, visible version, and generation budget of
  // MAX_REGENERATIONS. A shared counter used to make the letter tab a silent
  // dead end once the poem's budget was spent.
  let poemHistories = {};     // format id → generated versions (up to MAX each)
  let activeIndices = {};     // format id → index of the version showing
  let regenCounts = {};       // format id → generations used (initial + retries)
  let currentStyle = 'classic-dark';
  let currentLayout = 'side-by-side';
  let currentFrame = null; // chosen frame id from template.frameOptions
  let poemFirst = false;   // poem before photo (left in landscape, above in portrait)
  let orderType = 'self'; // 'self' or 'gift'
  let thirdPanelEnabled = false;
  let thirdPanelType = 'photo'; // 'photo' or 'text'

  // Poem format ('poem' or 'letter') for templates with poemFormats
  let poemFormat = 'poem';

  // Default frame shown before a photo is uploaded. The accent is the warm
  // gold the print pipeline uses for dividers (tributeRenderer PAPER_PALETTE)
  // — keep them in sync so the preview divider matches the printed one.
  const DEFAULT_AUTO_COLORS = {
    frame: '#6E5C4E', accent: '#B8975E', tone: 'dark',
    mat: '#1f1b17', bevel: '#B8975E', text: '#FAF8F5'
  };

  // Auto-matched print colors (colorMode: 'auto' templates)
  let currentColors = null;     // active { frame, accent, ... }
  let autoColors = null;        // server-derived match for the uploaded photo
  let paletteSwatches = [];     // [{ hex, population }] from the photo
  let activeSwatchIndex = -1;   // -1 = auto match

  // Custom color override state
  let accentOverride = null;   // null = auto-derive engraving color
  let frameOverride = false;   // true once the user picks a custom frame color

  // Sample poem shown in the frame before a real one is generated (display only)
  const SAMPLE_POEM = 'This is where their poem will appear.\nShare a memory or two below,\nand we’ll write something\nonly you could have written.';

  // Engraved symbol beside the name: 'none' | 'paw' | 'heart'
  let frameIcon = 'paw';
  const ICON_OPTIONS = [
    { id: 'none', label: 'None', svg: '' },
    { id: 'paw', label: 'Paw', svg: '<svg viewBox="0 0 64 64"><ellipse cx="14" cy="29" rx="5.4" ry="7.6"/><ellipse cx="25" cy="20" rx="5.6" ry="8.4"/><ellipse cx="39" cy="20" rx="5.6" ry="8.4"/><ellipse cx="50" cy="29" rx="5.4" ry="7.6"/><path d="M32 33c-9 0-15 6.6-15 13.4 0 6.5 6.4 8.6 15 8.6s15-2.1 15-8.6C47 39.6 41 33 32 33z"/></svg>' },
    { id: 'heart', label: 'Heart', svg: '<svg viewBox="0 0 64 64"><path d="M32 55C13 41 6 30 6 20.5 6 12.5 12 7 19 7c5.6 0 10.4 3.6 13 8 2.6-4.4 7.4-8 13-8 7 0 13 5.5 13 13.5C58 30 51 41 32 55z"/></svg>' }
  ];

  // Track whether a photo has been uploaded per panel
  const photoUploaded = {};   // panelId -> boolean

  // Debounce timer for resize → reattach divider handles
  let resizeTimer = null;

  // ── Helpers (template-driven labels) ──────────────────────

  /** The field ID used for the tribute "name" slot */
  function nameFieldId() {
    return (template && template.tributeMapping && template.tributeMapping.name) || 'petName';
  }

  /** The label word for the generated content – "Poem" or "Letter" */
  function poemLabel() {
    if (template && template.poemFormats) {
      const f = template.poemFormats.find(f => f.id === poemFormat);
      if (f && f.poemLabel) return f.poemLabel;
    }
    return (template && template.poemLabel) || 'Poem';
  }

  /**
   * Gift deep-link: /customize/pet-tribute?gift=1 opens the flow already set to
   * "Someone else's pet". Condolence senders arrive from a different place than
   * owners, and landing on the wrong toggle costs them the first thing they see.
   * A saved choice always wins — restoreState() runs after this and puts back
   * whatever the customer last picked.
   */
  function isGiftDeepLink() {
    try {
      const v = new URLSearchParams(window.location.search).get('gift');
      return v === '1' || v === 'true';
    } catch (e) {
      return false;
    }
  }

  /** Whether this template offers any 3-panel layouts (second photo) */
  function hasThreePanelLayouts() {
    if (!template || !template.layouts) return false;
    return Object.values(template.layouts).some(def => def.panels === 3);
  }

  // ── Poem Version History (module-level so both wireUp and restore can use) ──

  /** The active format key ('poem' for templates without a format toggle). */
  function fmtKey() {
    return (template && template.poemFormats) ? poemFormat : 'poem';
  }

  /** Version history for the active format (created on first use). */
  function fmtHistory() {
    const k = fmtKey();
    if (!poemHistories[k]) poemHistories[k] = [];
    return poemHistories[k];
  }

  /** Generations used by the active format. */
  function fmtRegenCount() {
    return regenCounts[fmtKey()] || 0;
  }

  // ── Afterglow (the quiet line under a generated tribute) ──
  //
  // The reveal is the emotional peak; the afterglow is what it leaves behind.
  // One understated line naming where the words came from turns "the AI wrote
  // this" into "this was written from what I remembered". Shown only for
  // tributes we generated — never for a poem chosen from the library.

  let afterglowTimer = null;

  function afterglowLine() {
    const fields = PreviewRenderer.getFields();
    const name = (fields[nameFieldId()] || '').trim();
    return name
      ? `Written from your memories of ${name}.`
      : 'Written from the memories you shared.';
  }

  function showAfterglow() {
    clearTimeout(afterglowTimer);
    afterglowTimer = null;
    const el = document.getElementById('poem-afterglow');
    if (!el) return;
    el.textContent = afterglowLine();
    el.style.display = '';
  }

  function hideAfterglow() {
    clearTimeout(afterglowTimer);
    afterglowTimer = null;
    const el = document.getElementById('poem-afterglow');
    if (el) el.style.display = 'none';
  }

  function updateVersionTabs() {
    const vt = document.getElementById('poem-version-tabs');
    if (!vt) return;
    const history = fmtHistory();
    if (history.length < 2) {
      vt.style.display = 'none';
      return;
    }
    vt.style.display = '';
    const active = activeIndices[fmtKey()] || 0;
    vt.innerHTML = history.map((_, i) =>
      `<button class="poem-version-tab${i === active ? ' active' : ''}" data-index="${i}">Version ${i + 1}</button>`
    ).join('');
    vt.querySelectorAll('.poem-version-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        showPoemVersion(parseInt(tab.dataset.index));
      });
    });
  }

  function showPoemVersion(index) {
    const history = fmtHistory();
    if (index < 0 || index >= history.length) return;
    activeIndices[fmtKey()] = index;
    const rt = document.getElementById('poem-result-text');
    if (rt) rt.textContent = history[index];
    PreviewRenderer.setField('poemText', history[index]);
    // Every version in the history is one we wrote from their memories.
    showAfterglow();
    updateVersionTabs();
    saveState();
  }

  /** Regen button + counter line reflect the ACTIVE format's budget. */
  function updateRegenUi() {
    const regenCount = document.getElementById('regen-count');
    const regenBtn = document.getElementById('poem-regenerate-btn');
    if (!regenCount || !regenBtn) return;
    const remaining = MAX_REGENERATIONS - fmtRegenCount();
    if (remaining <= 0) {
      regenCount.textContent = `No more versions of this ${poemLabel().toLowerCase()} – you can still edit it`;
      regenBtn.disabled = true;
    } else {
      regenCount.textContent = `${remaining} more version${remaining === 1 ? '' : 's'} available`;
      regenBtn.disabled = false;
    }
  }

  /**
   * Point the poem section at the active format: show its generated text if
   * any exists, otherwise bring back the generate button so the first
   * generation of THIS format is always reachable (each format has its own
   * budget). Called on format toggle and after state restore.
   */
  function syncPoemSectionToFormat() {
    const resultDiv = document.getElementById('poem-result');
    const resultText = document.getElementById('poem-result-text');
    const generateBtn = document.getElementById('generate-poem-btn');
    const editArea = document.getElementById('poem-edit-area');
    if (!resultDiv || !resultText || !generateBtn) return;

    if (editArea) editArea.style.display = 'none';
    const history = fmtHistory();
    if (history.length > 0) {
      const idx = Math.min(activeIndices[fmtKey()] || 0, history.length - 1);
      activeIndices[fmtKey()] = idx;
      resultText.textContent = history[idx];
      PreviewRenderer.setField('poemText', history[idx]);
      showAfterglow();
      resultDiv.style.display = '';
      generateBtn.style.display = 'none';
    } else {
      // Nothing generated in this format yet — the generate button IS the way
      // in, so it must always come back here. (The preview keeps showing the
      // other format's text until this one is generated.)
      hideAfterglow();
      resultDiv.style.display = 'none';
      generateBtn.style.display = '';
      generateBtn.disabled = false;
    }
    updateVersionTabs();
    updateRegenUi();
  }

  // ── Initialization ─────────────────────────────────────────

  async function init() {
    try {
      const tmplRes = await fetch(`/api/templates/${TEMPLATE_ID}`);

      if (!tmplRes.ok) {
        formPane.innerHTML = '<p style="padding:2rem;color:var(--color-error)">Could not load template. <a href="/">Go back</a></p>';
        return;
      }

      template = await tmplRes.json();

      // Fetch poems filtered by template category
      const poemsRes = await fetch(`/api/poems?category=${template.category}`);
      poems = await poemsRes.json();

      // Dynamic page title
      document.title = `Create ${template.name} \u2013 Still Beside Me`;

      // Initialize preview renderer with container ID
      PreviewRenderer.init('preview-panels', template);

      // Deter casual saving of the tribute art. The preview (photo + poem) is
      // the product, so block the "Save image as…" context menu and drag-to-
      // save on the canvases and photo thumbnails. Scoped to <canvas>/<img> so
      // right-click still works normally on text, links and inputs. This is a
      // deterrent, not DRM — screenshots and devtools can't be prevented.
      protectImages();

      // Wire up photo crop interaction for main photo panel
      initPhotoCropInteraction('photo');

      // ?gift=1 pre-selects "Someone else's pet" before the form is built, so
      // the toggle, the gift-only fields and the gift hint all render in their
      // gift state rather than flipping a beat later. restoreState() below
      // still overrides this with an explicit saved choice.
      if (template.giftLabels && isGiftDeepLink()) {
        orderType = 'gift';
      }

      // Build the guided form
      buildGuidedForm();

      // The build only paints gift VISIBILITY; the gift wording comes from
      // template.giftLabels, so apply it when we arrived pre-set to gift.
      if (orderType === 'gift') updateFormForOrderType();

      // Build layout & style selectors (dynamic)
      rebuildLayoutSelector();
      buildStyleSelector();
      buildPanelToggle();

      // Auto-color templates: show the elegant dark frame immediately with a
      // sample poem so the panel isn't empty before an upload. A real photo
      // upload or swatch tap replaces this with the auto-matched mat colors.
      if (template.colorMode === 'auto') {
        PreviewRenderer.setColors(DEFAULT_AUTO_COLORS);
        PreviewRenderer.setPreviewPoem(SAMPLE_POEM);
        PreviewRenderer.setPreviewHeader('Banjo', '2014 – 2026');
      }
      // Frame chooser (black/white/oak/natural + Signature upgrades).
      if (template.frameOptions) {
        buildFrameSelector();
        initFrameScrollHint();
      }

      // Restore saved state
      restoreState();

      // Set initial frame size from selected product
      const initialProduct = document.querySelector('.product-option.selected');
      if (initialProduct && initialProduct.dataset.sku && PreviewRenderer.setFrameSize) {
        PreviewRenderer.setFrameSize(initialProduct.dataset.sku);
        updateFrameSectionVisibility(initialProduct.dataset.sku);
      }

      // A restored session can arrive with a long poem already in place.
      schedulePoemFitNote();

      // Attach divider handles after initial layout
      requestAnimationFrame(() => {
        attachDividerHandles();
      });

      // Reattach dividers on window resize (debounced)
      window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => attachDividerHandles(), 150);
      });

    } catch (err) {
      console.error('Failed to load:', err);
      formPane.innerHTML = '<p style="padding:2rem;color:var(--color-error)">Something went wrong. <a href="/">Go back</a></p>';
    }
  }

  // Block right-click "Save image as…" and drag-to-desktop on the tribute
  // canvases and photo thumbnails. Delegated at the document so it also covers
  // canvases/images created later (layout swaps, uploads). Only images are
  // affected — text, links and inputs keep their native context menu.
  function protectImages() {
    const isImageLike = (el) =>
      el && (el.tagName === 'CANVAS' || el.tagName === 'IMG');
    document.addEventListener('contextmenu', (e) => {
      if (isImageLike(e.target)) e.preventDefault();
    });
    document.addEventListener('dragstart', (e) => {
      if (isImageLike(e.target)) e.preventDefault();
    });
  }

  // ── Guided Form Builder ──────────────────────────────────────

  function buildGuidedForm() {
    formPane.innerHTML = '';

    // Order type toggle – only show when template defines giftLabels
    if (template.giftLabels) {
      const toggleWrap = document.createElement('div');
      toggleWrap.innerHTML = `
        <div class="form-intro">Who is this tribute for?<span>This helps us personalize the experience</span></div>
        <div class="order-type-toggle" id="order-type-toggle">
          <button class="order-type-option${orderType === 'self' ? ' active' : ''}" data-type="self">My pet</button>
          <button class="order-type-option${orderType === 'gift' ? ' active' : ''}" data-type="gift">Someone else's pet</button>
        </div>
        <p class="order-type-hint" id="order-type-hint">${orderType === 'gift' ? 'You\'re creating a meaningful gift \u2013 we\'ll guide you through it.' : 'Each detail helps us write their tribute.'}</p>
      `;
      formPane.appendChild(toggleWrap);

      // Wire toggle
      toggleWrap.querySelectorAll('.order-type-option').forEach(btn => {
        btn.addEventListener('click', () => {
          orderType = btn.dataset.type;
          toggleWrap.querySelectorAll('.order-type-option').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const hint = document.getElementById('order-type-hint');
          if (hint) {
            hint.textContent = orderType === 'gift'
              ? 'You\'re creating a meaningful gift \u2013 we\'ll guide you through it.'
              : 'Each detail helps us write their tribute.';
          }
          updateFormForOrderType();
          saveState();
        });
      });
    } else {
      // Human templates: simple intro, no toggle
      const introWrap = document.createElement('div');
      introWrap.innerHTML = `
        <div class="form-intro">Tell us about them<span>Every detail helps us write something truly personal</span></div>
      `;
      formPane.appendChild(introWrap);
    }

    // 1. Photo upload
    const photoSection = createSection('Share their photo');
    const slot = template.photoSlots[0];
    photoSection.appendChild(createUploadZone(slot));

    // Second photo upload zone (hidden until third panel is added)
    const slot2 = template.photoSlots.find(s => s.id === 'panel2');
    if (slot2) {
      const secondUpload = createUploadZone(slot2);
      secondUpload.id = 'second-photo-section';
      secondUpload.style.display = thirdPanelEnabled && thirdPanelType === 'photo' ? '' : 'none';
      photoSection.appendChild(secondUpload);
    }

    formPane.appendChild(photoSection);

    // 2-N. Memory fields (everything except poem-selector)
    const memSection = createSection('Tell us about them');

    // Gift-mode helper note (only for templates with giftLabels). Uses the same
    // declarative visibility rule as gift-only fields \u2014 see createField.
    if (template.giftLabels) {
      const giftNote = document.createElement('p');
      giftNote.id = 'gift-detail-note';
      giftNote.className = 'gift-detail-note';
      giftNote.textContent = 'Share what you know. The more details, the more personal the ' + poemLabel().toLowerCase() + ' \u2013 but even just a name and photo make a beautiful tribute.';
      giftNote.dataset.showWhenOrderType = 'gift';
      giftNote.style.display = orderType === 'gift' ? '' : 'none';
      memSection.appendChild(giftNote);
    }

    for (const field of template.memoryFields) {
      if (field.type === 'poem-selector') continue;
      memSection.appendChild(createField(field));
    }
    formPane.appendChild(memSection);

    // Poem/Letter generation section
    formPane.appendChild(createPoemSection());

    // Size selector
    formPane.appendChild(createSizeSection());

    // Purchase action
    const cartSection = document.createElement('div');
    cartSection.className = 'cart-action';
    cartSection.id = 'cart-section';
    cartSection.innerHTML = `
      <button class="btn btn-warm btn-lg" id="purchase-btn">
        Continue to Checkout
      </button>
      <p class="proof-note" id="proof-note" role="status" aria-live="polite" hidden></p>
      <ul class="checkout-reassurance">
        <li>You see the finished proof and approve it before you pay</li>
        <li>Full refund any time before it goes to print &mdash; no questions asked</li>
        <li>Free replacement if it ever arrives damaged</li>
      </ul>
      <p class="checkout-securely">Secure checkout &middot; Free US shipping &middot; Made to order in the USA</p>
    `;
    formPane.appendChild(cartSection);

    // Wire up purchase button after it's in the DOM
    setTimeout(() => {
      updatePurchaseButton();
      document.getElementById('purchase-btn').addEventListener('click', handlePurchase);
    }, 0);
  }

  function createSection(title) {
    const section = document.createElement('div');
    section.className = 'form-section';
    section.innerHTML = `<h2 class="form-section-title">${title}</h2>`;
    return section;
  }

  // ── Upload Zone ────────────────────────────────────────────

  function createUploadZone(slot) {
    const wrapper = document.createElement('div');
    wrapper.className = 'field-group';
    wrapper.id = `upload-zone-wrapper-${slot.id}`;

    wrapper.innerHTML = `
      <div class="upload-zone" id="upload-zone-${slot.id}">
        <div class="upload-zone-icon">&#128247;</div>
        <div class="upload-zone-text">${slot.sublabel || slot.label}</div>
        <div class="upload-zone-hint">Drag & drop, or click to browse</div>
        <input type="file" id="upload-input-${slot.id}" accept="image/jpeg,image/png,image/webp,image/heic,image/heif">
      </div>
    `;
    // No capture attribute on the file input: customers pick an existing photo of their pet
    // from the gallery; capture="environment" forced Android straight
    // into the camera and hid the photo library.

    const zone = wrapper.querySelector('.upload-zone');
    const input = wrapper.querySelector('input[type="file"]');

    zone.addEventListener('click', () => input.click());

    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('drag-over');
    });
    zone.addEventListener('dragleave', () => {
      zone.classList.remove('drag-over');
    });
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) {
        handleFileUpload(slot.id, e.dataTransfer.files[0], wrapper);
      }
    });

    input.addEventListener('change', () => {
      if (input.files.length > 0) {
        handleFileUpload(slot.id, input.files[0], wrapper);
      }
    });

    return wrapper;
  }

  async function handleFileUpload(slotId, file, wrapper) {
    // Map slot IDs to panel IDs
    const panelId = slotId === 'main' ? 'photo' : slotId;

    // HEIC/HEIF can't be decoded by non-Apple browsers, so a local object-URL
    // preview renders blank and reads as a failed upload. Skip the local
    // preview for those — the server converts to JPEG on upload and we swap
    // in its thumbnail as soon as the response arrives.
    const isHeic = /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type || '');
    const localUrl = isHeic ? null : URL.createObjectURL(file);
    photoUploaded[panelId] = true;
    if (localUrl) PreviewRenderer.setPhoto(panelId, localUrl, '50% 50%');
    // Now that there's a photo to move, surface the on-photo reposition
    // affordance (drag hint + grab cursor + zoom buttons) right on the preview.
    ensurePhotoAdjustUI(panelId);

    showUploadPreview(slotId, localUrl, wrapper, isHeic ? 'Preparing your photo…' : 'Uploading...');

    const formData = new FormData();
    formData.append('photo', file);
    formData.append('slotId', slotId);

    try {
      const res = await fetch('/api/images/upload', {
        method: 'POST',
        body: formData
      });
      const data = await res.json();

      if (data.success) {
        PreviewRenderer.setPhoto(panelId, data.thumbnailUrl, data.crop.position);
        showUploadPreview(slotId, data.thumbnailUrl, wrapper, null, data.quality);

        // (Photo color-matching removed — the frame is the customer's choice,
        // the tribute background stays an elegant dark. Frame selector is built
        // once at init and is independent of the uploaded photo.)

        saveState();
      } else {
        showUploadPreview(slotId, localUrl, wrapper, data.error || 'Upload failed');
      }
    } catch (err) {
      console.error('Upload error:', err);
      showUploadPreview(slotId, localUrl, wrapper, 'Upload failed \u2013 using local preview');
    }
  }

  function showUploadPreview(slotId, imageUrl, wrapper, statusMsg, quality) {
    const existing = wrapper.querySelector('.upload-preview');
    const zone = wrapper.querySelector('.upload-zone');

    if (zone) zone.style.display = 'none';

    // HEIC uploads have no local preview (browsers outside Safari can't
    // decode them) — show a quiet placeholder until the server's converted
    // thumbnail arrives.
    const PLACEHOLDER = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="90"><rect width="120" height="90" fill="#EFEBE4"/><text x="60" y="50" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#928B82">Preparing photo</text></svg>');

    if (existing) {
      existing.querySelector('img').src = imageUrl || PLACEHOLDER;
    } else {
      const preview = document.createElement('div');
      preview.className = 'upload-preview';
      preview.innerHTML = `
        <img src="${imageUrl || PLACEHOLDER}" alt="Uploaded photo">
        <div class="upload-preview-actions">
          <button class="upload-replace-btn">Replace photo</button>
          <span class="quality-badge" id="quality-badge-${slotId}"></span>
        </div>
      `;

      preview.querySelector('.upload-replace-btn').addEventListener('click', () => {
        preview.remove();
        zone.style.display = '';
      });

      wrapper.appendChild(preview);
    }

    const badge = wrapper.querySelector(`#quality-badge-${slotId}`);
    if (badge && quality) {
      badge.textContent = quality.tier.charAt(0).toUpperCase() + quality.tier.slice(1);
      badge.className = `quality-badge ${quality.tier}`;
    } else if (badge && statusMsg) {
      badge.textContent = statusMsg;
      badge.className = 'quality-badge';
    }

    const existingMsg = wrapper.querySelector('.quality-message');
    if (existingMsg) existingMsg.remove();
    const existingAssurance = wrapper.querySelector('.photo-assurance');
    if (existingAssurance) existingAssurance.remove();

    // Show crop hint
    const existingCropHint = wrapper.querySelector('.crop-hint');
    if (!existingCropHint && (quality || statusMsg)) {
      const cropHint = document.createElement('p');
      cropHint.className = 'crop-hint';
      const isTouch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      cropHint.textContent = isTouch
        ? 'Drag to reposition. Pinch to zoom.'
        : 'Drag the preview to reposition. Scroll to zoom.';
      wrapper.appendChild(cropHint);
    }

    if (quality) {
      if (quality.tier === 'low') {
        const msg = document.createElement('p');
        msg.className = 'quality-message';
        msg.textContent = 'This photo is a little lower resolution. A real person reviews every photo before printing \u2013 if it won\'t hold up at the size you chose, we\'ll reach out before anything is made.';
        wrapper.appendChild(msg);
      } else if (quality.tier === 'usable') {
        const msg = document.createElement('p');
        msg.className = 'quality-message';
        msg.textContent = 'This will print nicely. A real person reviews every photo before it goes to print.';
        wrapper.appendChild(msg);
      }

      const assurance = document.createElement('p');
      assurance.className = 'photo-assurance';
      assurance.innerHTML = '&#10003; A real person reviews every photo before it\'s printed';
      wrapper.appendChild(assurance);
    }
  }

  // ── On-photo reposition affordance ─────────────────────────
  //
  // Drag-to-reposition worked but was undiscoverable — the only hint lived
  // in the form pane, nowhere near the photo. Put the cue ON the photo: a
  // fading "Drag to reposition" pill, a grab cursor, and +/- zoom buttons so
  // resizing is discoverable too. Created only once a photo exists.

  function ensurePhotoAdjustUI(panelId) {
    const panelEl = document.getElementById('panel-' + panelId);
    if (!panelEl) return;

    if (!photoUploaded[panelId]) {
      const h = panelEl.querySelector('.photo-adjust-hint');
      const z = panelEl.querySelector('.photo-zoom-ctrl');
      if (h) h.remove();
      if (z) z.remove();
      panelEl.classList.remove('is-adjustable');
      return;
    }

    panelEl.classList.add('is-adjustable');

    if (!panelEl.querySelector('.photo-adjust-hint')) {
      const isTouch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
      const hint = document.createElement('div');
      hint.className = 'photo-adjust-hint';
      // Keep it short — it sits on a narrow half-frame photo panel, and the
      // +/- buttons already communicate zoom. (isTouch kept for future copy.)
      void isTouch;
      hint.innerHTML = '<span class="photo-adjust-ico">⤢</span>Drag to reposition';
      panelEl.appendChild(hint);
    }

    if (!panelEl.querySelector('.photo-zoom-ctrl')) {
      const zoom = document.createElement('div');
      zoom.className = 'photo-zoom-ctrl';
      zoom.innerHTML =
        '<button type="button" data-z="in" aria-label="Zoom in">+</button>'
        + '<button type="button" data-z="out" aria-label="Zoom out">−</button>';
      zoom.querySelectorAll('button').forEach((b) => {
        // Stop the mousedown/touchstart from also starting a photo drag.
        ['mousedown', 'touchstart'].forEach((ev) =>
          b.addEventListener(ev, (e) => e.stopPropagation()));
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const crop = PreviewRenderer.getPhotoCrop(panelId);
          const delta = b.dataset.z === 'in' ? 0.25 : -0.25;
          PreviewRenderer.setPhotoCrop(panelId, crop.zoom + delta, crop.panX, crop.panY);
          dismissPhotoHint(panelId);
          saveState();
        });
      });
      panelEl.appendChild(zoom);
    }
  }

  function dismissPhotoHint(panelId) {
    const panelEl = document.getElementById('panel-' + panelId);
    const hint = panelEl && panelEl.querySelector('.photo-adjust-hint');
    if (hint) hint.classList.add('dismissed');
  }

  // ── Photo Crop Interaction (drag to pan, scroll to zoom) ────

  function initPhotoCropInteraction(panelId) {
    const canvas = PreviewRenderer.getPhotoCanvas(panelId);
    if (!canvas) return;
    const panelEl = canvas.closest('.panel');

    let isDragging = false;
    let dragStartX = 0;
    let dragStartY = 0;
    let startPanX = 0.5;
    let startPanY = 0.5;

    // Mouse drag
    canvas.addEventListener('mousedown', (e) => {
      if (!photoUploaded[panelId]) return;
      isDragging = true;
      dragStartX = e.clientX;
      dragStartY = e.clientY;
      const crop = PreviewRenderer.getPhotoCrop(panelId);
      startPanX = crop.panX;
      startPanY = crop.panY;
      if (panelEl) panelEl.classList.add('dragging');
      dismissPhotoHint(panelId);
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragStartX;
      const dy = e.clientY - dragStartY;
      const rect = canvas.getBoundingClientRect();
      const crop = PreviewRenderer.getPhotoCrop(panelId);
      const sensitivity = 1.5 / crop.zoom;
      const newPanX = startPanX - (dx / rect.width) * sensitivity;
      const newPanY = startPanY - (dy / rect.height) * sensitivity;
      PreviewRenderer.setPhotoCrop(panelId, crop.zoom, newPanX, newPanY);
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        if (panelEl) panelEl.classList.remove('dragging');
        saveState();
      }
    });

    // Scroll to zoom
    canvas.addEventListener('wheel', (e) => {
      if (!photoUploaded[panelId]) return;
      e.preventDefault();
      const crop = PreviewRenderer.getPhotoCrop(panelId);
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      PreviewRenderer.setPhotoCrop(panelId, crop.zoom + delta, crop.panX, crop.panY);
      dismissPhotoHint(panelId);
      saveState();
    }, { passive: false });

    // Touch drag — with directional intent so the page can still scroll.
    // On the small sticky preview, a vertical swipe should scroll the page, not
    // get hijacked into panning the photo. We wait for the first meaningful move
    // to decide intent:
    //   • two fingers                          → pinch-zoom
    //   • fullscreen zoom, photo already zoomed in, or a horizontal-dominant
    //     drag                                 → pan the photo
    //   • vertical-dominant drag at default zoom → let the page scroll
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartPanX = 0.5;
    let touchStartPanY = 0.5;
    let initialPinchDist = 0;
    let pinchStartZoom = 1;
    let gestureMode = 'none'; // 'none' | 'undecided' | 'pan' | 'scroll' | 'pinch'
    const INTENT_THRESHOLD = 8; // px of movement before committing to pan vs scroll

    canvas.addEventListener('touchstart', (e) => {
      if (!photoUploaded[panelId]) return;
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        const crop = PreviewRenderer.getPhotoCrop(panelId);
        touchStartPanX = crop.panX;
        touchStartPanY = crop.panY;
        gestureMode = 'undecided';
        // Don't preventDefault yet — this gesture may belong to the page scroll.
      } else if (e.touches.length === 2) {
        initialPinchDist = Math.hypot(
          e.touches[1].clientX - e.touches[0].clientX,
          e.touches[1].clientY - e.touches[0].clientY
        );
        pinchStartZoom = PreviewRenderer.getPhotoCrop(panelId).zoom;
        gestureMode = 'pinch';
        dismissPhotoHint(panelId);
        e.preventDefault();
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (!photoUploaded[panelId]) return;
      const crop = PreviewRenderer.getPhotoCrop(panelId);

      // Pinch-zoom (two fingers) always wins.
      if (e.touches.length === 2 || gestureMode === 'pinch') {
        if (e.touches.length === 2) {
          const dist = Math.hypot(
            e.touches[1].clientX - e.touches[0].clientX,
            e.touches[1].clientY - e.touches[0].clientY
          );
          const scale = dist / initialPinchDist;
          PreviewRenderer.setPhotoCrop(panelId, pinchStartZoom * scale, crop.panX, crop.panY);
          e.preventDefault();
        }
        return;
      }

      if (e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - touchStartX;
      const dy = e.touches[0].clientY - touchStartY;

      if (gestureMode === 'undecided') {
        if (Math.abs(dx) < INTENT_THRESHOLD && Math.abs(dy) < INTENT_THRESHOLD) return;
        const paneEl = canvas.closest('.preview-pane');
        const inZoomMode = !!paneEl && paneEl.classList.contains('zoomed');
        // Pan when adjusting is the clear intent; otherwise let the page scroll.
        if (inZoomMode || crop.zoom > 1.01 || Math.abs(dx) > Math.abs(dy)) {
          gestureMode = 'pan';
          dismissPhotoHint(panelId);
        } else {
          gestureMode = 'scroll';
        }
      }

      if (gestureMode === 'pan') {
        const rect = canvas.getBoundingClientRect();
        const sensitivity = 1.5 / crop.zoom;
        PreviewRenderer.setPhotoCrop(
          panelId,
          crop.zoom,
          touchStartPanX - (dx / rect.width) * sensitivity,
          touchStartPanY - (dy / rect.height) * sensitivity
        );
        e.preventDefault();
      }
      // gestureMode === 'scroll' → do nothing; the browser scrolls the page.
    }, { passive: false });

    canvas.addEventListener('touchend', () => {
      if (gestureMode === 'pan' || gestureMode === 'pinch') saveState();
      gestureMode = 'none';
    });

    // Empty photo panel is a real upload button: clicking the on-canvas
    // "Upload their photo" placeholder opens the file picker. Once a photo
    // exists the click does nothing here — the panel becomes drag-to-reposition.
    const slotId = panelId === 'photo' ? 'main' : panelId;
    canvas.addEventListener('click', () => {
      if (photoUploaded[panelId]) return;
      const input = document.getElementById('upload-input-' + slotId);
      if (input) input.click();
    });
    // Cursor is owned by CSS: pointer while empty, grab once a photo is loaded.
  }

  // ── Divider Handles ──────────────────────────────────────────

  function attachDividerHandles() {
    const ctr = PreviewRenderer.getContainer();
    if (!ctr) return;

    ctr.querySelectorAll('.divider-handle').forEach(h => h.remove());

    const style = getComputedStyle(ctr);
    const colTracks = style.gridTemplateColumns.split(/\s+/).map(parseFloat);
    const rowTracks = style.gridTemplateRows.split(/\s+/).map(parseFloat);
    const gap = parseFloat(style.gap) || 0;

    if (colTracks.length > 1) {
      let x = 0;
      for (let i = 0; i < colTracks.length - 1; i++) {
        x += colTracks[i];
        createHandle(ctr, 'col', i, x + gap * i + gap / 2, colTracks, rowTracks, gap);
      }
    }

    if (rowTracks.length > 1) {
      let y = 0;
      for (let i = 0; i < rowTracks.length - 1; i++) {
        y += rowTracks[i];
        createHandle(ctr, 'row', i, y + gap * i + gap / 2, colTracks, rowTracks, gap);
      }
    }
  }

  function createHandle(ctr, axis, index, pos, colTracks, rowTracks, gap) {
    const handle = document.createElement('div');
    handle.className = `divider-handle ${axis}`;

    if (axis === 'col') {
      handle.style.left = pos + 'px';
    } else {
      handle.style.top = pos + 'px';
    }

    ctr.appendChild(handle);

    let startPos = 0;
    let startFr = null;

    function onStart(clientX, clientY) {
      startPos = axis === 'col' ? clientX : clientY;
      startFr = PreviewRenderer.getCurrentFrValues();
      handle.classList.add('dragging');
      document.body.style.userSelect = 'none';
      document.body.style.cursor = axis === 'col' ? 'col-resize' : 'row-resize';
    }

    function onMove(clientX, clientY) {
      if (!startFr) return;

      const ctrRect = ctr.getBoundingClientRect();
      const totalPx = axis === 'col' ? ctrRect.width : ctrRect.height;

      const delta = (axis === 'col' ? clientX : clientY) - startPos;
      const deltaPct = delta / totalPx;

      const frArr = axis === 'col' ? [...startFr.columns] : [...startFr.rows];
      const totalFr = frArr.reduce((a, b) => a + b, 0);
      const deltaFr = deltaPct * totalFr;

      let newA = frArr[index] + deltaFr;
      let newB = frArr[index + 1] - deltaFr;

      if (newA < MIN_FR) {
        newB -= (MIN_FR - newA);
        newA = MIN_FR;
      }
      if (newB < MIN_FR) {
        newA -= (MIN_FR - newB);
        newB = MIN_FR;
      }

      frArr[index] = Math.max(MIN_FR, newA);
      frArr[index + 1] = Math.max(MIN_FR, newB);

      if (axis === 'col') {
        PreviewRenderer.setCustomRatios(currentLayout, frArr, startFr.rows);
      } else {
        PreviewRenderer.setCustomRatios(currentLayout, startFr.columns, frArr);
      }
    }

    function onEnd() {
      if (!startFr) return;
      startFr = null;
      handle.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      saveState();
      requestAnimationFrame(() => attachDividerHandles());
    }

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      onStart(e.clientX, e.clientY);

      const moveHandler = (e) => onMove(e.clientX, e.clientY);
      const upHandler = () => {
        onEnd();
        window.removeEventListener('mousemove', moveHandler);
        window.removeEventListener('mouseup', upHandler);
      };
      window.addEventListener('mousemove', moveHandler);
      window.addEventListener('mouseup', upHandler);
    });

    handle.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      onStart(touch.clientX, touch.clientY);

      const moveHandler = (e) => {
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
      };
      const endHandler = () => {
        onEnd();
        window.removeEventListener('touchmove', moveHandler);
        window.removeEventListener('touchend', endHandler);
      };
      window.addEventListener('touchmove', moveHandler, { passive: false });
      window.addEventListener('touchend', endHandler);
    }, { passive: false });

    handle.addEventListener('dblclick', () => {
      PreviewRenderer.resetCustomRatios(currentLayout);
      saveState();
      requestAnimationFrame(() => attachDividerHandles());
    });
  }

  // ── Third Panel Toggle ──────────────────────────────────────

  function buildPanelToggle() {
    const wrap = document.getElementById('panel-toggle-wrap');
    if (!wrap) return;
    // No second-photo option when the template has no 3-panel layouts
    if (!hasThreePanelLayouts()) {
      wrap.style.display = 'none';
      return;
    }
    updatePanelToggle(wrap);
  }

  function updatePanelToggle(wrap) {
    if (!wrap) wrap = document.getElementById('panel-toggle-wrap');
    if (!wrap) return;

    if (thirdPanelEnabled) {
      wrap.innerHTML = `
        <div class="panel-toggle-actions">
          <button class="add-panel-btn" id="remove-panel-btn"><span class="icon">&minus;</span> Remove second photo</button>
          <button class="swap-photos-btn" id="swap-photos-btn"><span class="icon">&#8646;</span> Swap photos</button>
        </div>`;
      wrap.querySelector('#remove-panel-btn').addEventListener('click', () => {
        removeThirdPanel();
      });
      wrap.querySelector('#swap-photos-btn').addEventListener('click', () => {
        PreviewRenderer.swapPhotos();
        // Swap the upload preview thumbnails too
        swapUploadPreviews();
        saveState();
      });
    } else {
      wrap.innerHTML = `<button class="add-panel-btn" id="add-panel-btn"><span class="icon">+</span> Add second photo</button>`;
      wrap.querySelector('#add-panel-btn').addEventListener('click', () => {
        addThirdPanel();
      });
    }
  }

  function swapUploadPreviews() {
    const mainWrapper = document.getElementById('upload-zone-wrapper-main');
    const panel2Wrapper = document.getElementById('upload-zone-wrapper-panel2');
    if (!mainWrapper || !panel2Wrapper) return;

    const mainImg = mainWrapper.querySelector('.upload-preview img');
    const panel2Img = panel2Wrapper.querySelector('.upload-preview img');
    if (!mainImg || !panel2Img) return;

    const tmpSrc = mainImg.src;
    mainImg.src = panel2Img.src;
    panel2Img.src = tmpSrc;

    // Swap the uploaded state tracking too
    const tmpUploaded = photoUploaded['photo'];
    photoUploaded['photo'] = photoUploaded['panel2'];
    photoUploaded['panel2'] = tmpUploaded;

    // Keep the reposition affordance in sync with which panels now hold a photo.
    ensurePhotoAdjustUI('photo');
    ensurePhotoAdjustUI('panel2');
  }

  function addThirdPanel() {
    thirdPanelEnabled = true;
    thirdPanelType = 'photo';

    const layoutMap = {
      'side-by-side': 'hero-left',
      'stacked': 'hero-top'
    };
    const newLayout = layoutMap[currentLayout] || 'hero-left';
    currentLayout = newLayout;

    PreviewRenderer.setLayout(newLayout);
    rebuildLayoutSelector();
    updatePanelToggle();

    const secondSection = document.getElementById('second-photo-section');
    if (secondSection) secondSection.style.display = '';

    requestAnimationFrame(() => {
      initPhotoCropInteraction('panel2');
      attachDividerHandles();
    });

    saveState();
  }

  function removeThirdPanel() {
    thirdPanelEnabled = false;

    const layoutMap = {
      'hero-left': 'side-by-side',
      'hero-top': 'stacked',
      'photos-left': 'side-by-side',
      'tribute-top': 'stacked'
    };
    const newLayout = layoutMap[currentLayout] || 'side-by-side';
    currentLayout = newLayout;

    PreviewRenderer.setLayout(newLayout);
    rebuildLayoutSelector();
    updatePanelToggle();

    const secondSection = document.getElementById('second-photo-section');
    if (secondSection) secondSection.style.display = 'none';

    requestAnimationFrame(() => attachDividerHandles());
    saveState();
  }

  // ── Layout Selector (Dynamic) ────────────────────────────────

  function rebuildLayoutSelector() {
    const container = document.getElementById('layout-selector');
    if (!container) return;

    const layouts = PreviewRenderer.getLayouts();
    const panelCount = thirdPanelEnabled ? 3 : 2;

    const available = Object.entries(layouts).filter(([, def]) => def.panels === panelCount);

    container.innerHTML = available.map(([key, def]) => {
      const isActive = key === currentLayout ? ' active' : '';
      const icon = buildLayoutIcon(def);
      return `<div>
        <div class="layout-option layout-option-grid${isActive}" data-layout="${key}" style="${layoutIconGridStyle(def)}${layoutIconBoxStyle(def)}">
          ${icon}
        </div>
        <div class="layout-label">${def.label || key}</div>
      </div>`;
    }).join('');

    container.querySelectorAll('.layout-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const layout = opt.dataset.layout;
        currentLayout = layout;
        PreviewRenderer.setLayout(layout);

        container.querySelectorAll('.layout-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');

        requestAnimationFrame(() => attachDividerHandles());
        saveState();
      });
    });
  }

  function layoutIconGridStyle(def) {
    const cols = def.columns.map(v => v + 'fr').join(' ');
    const rows = def.rows.map(v => v + 'fr').join(' ');
    // Single-quote the area rows: this string goes into a double-quoted HTML
    // style="" attribute, so double quotes here would terminate the attribute
    // early and drop every declaration after it.
    const areas = def.areas.map(r => "'" + r.join(' ') + "'").join(' ');
    return `grid-template-columns:${cols};grid-template-rows:${rows};grid-template-areas:${areas};`;
  }

  // Size each thumbnail to its frame's true orientation so Landscape reads as a
  // wide little frame and Portrait as a tall one — the shape itself carries the
  // choice. Both fit inside the same square bounding box (contain), so a wide
  // one is short and a tall one is narrow.
  function layoutIconBoxStyle(def) {
    const parts = (def.aspectRatio || '1/1').split('/');
    const aw = parseFloat(parts[0]) || 1;
    const ah = parseFloat(parts[1]) || 1;
    const MAX = 60; // px, the longer side of the bounding box
    let w, h;
    if (aw >= ah) { w = MAX; h = Math.round(MAX * ah / aw); }
    else { h = MAX; w = Math.round(MAX * aw / ah); }
    return `width:${w}px;height:${h}px;`;
  }

  function buildLayoutIcon(def) {
    const names = new Set();
    for (const row of def.areas) {
      for (const name of row) names.add(name);
    }
    return Array.from(names).map(name => {
      const typeClass = name === 'photo' ? 'layout-icon-photo'
        : name === 'tribute' ? 'layout-icon-tribute'
        : 'layout-icon-panel2';
      return `<div class="layout-icon-block ${typeClass}" style="grid-area:${name}"></div>`;
    }).join('');
  }

  // ── Form Fields ────────────────────────────────────────────

  function createField(field) {
    const group = document.createElement('div');
    group.className = 'field-group';

    // Declarative visibility: a field can name the order type it belongs to
    // (template `showWhen`). The wrapper carries the rule so the order-type
    // sweep in updateFormForOrderType can find it without knowing field ids.
    if (field.showWhen && field.showWhen.orderType) {
      group.dataset.showWhenOrderType = field.showWhen.orderType;
      group.style.display = orderType === field.showWhen.orderType ? '' : 'none';
    }

    let inputHtml = '';
    const sublabelHtml = field.sublabel ? `<span class="sublabel">${field.sublabel}</span>` : '';
    const placeholder = field.placeholder || '';

    switch (field.type) {
      case 'text':
        inputHtml = `<input type="text" id="field-${field.id}" maxlength="${field.maxLength || 100}" placeholder="${placeholder}">`;
        break;

      case 'textarea':
        inputHtml = `<textarea id="field-${field.id}" maxlength="${field.maxLength || 300}" rows="3" placeholder="${placeholder}"></textarea>`;
        if (field.maxLength) {
          inputHtml += `<div class="char-count"><span id="count-${field.id}">0</span>/${field.maxLength}</div>`;
        }
        break;

      case 'select': {
        const options = (field.options || []).map(o =>
          `<option value="${o}">${o}</option>`
        ).join('');
        inputHtml = `<select id="field-${field.id}"><option value="">Choose...</option>${options}</select>`;
        break;
      }
    }

    group.innerHTML = `
      <label for="field-${field.id}">
        ${field.label}${field.required ? '' : ' <span style="color:var(--color-muted);font-weight:400">(optional)</span>'}
      </label>
      ${sublabelHtml}
      ${inputHtml}
    `;

    const input = group.querySelector('input, textarea, select');
    if (input) {
      input.addEventListener('input', () => {
        PreviewRenderer.setField(field.id, input.value);
        saveState();

        if (field.maxLength && field.type === 'textarea') {
          const count = group.querySelector(`#count-${field.id}`);
          if (count) count.textContent = input.value.length;
        }
      });
    }

    if (field.id === 'giftNote' && input) {
      group.appendChild(createGiftNoteAssist(input, field));
    }

    return group;
  }

  /**
   * "Help me write it" for the gift note.
   *
   * A condolence sender is comparing this to sending flowers, which takes
   * ninety seconds — a blank textarea asking them to compose a memorial message
   * is where they abandon. So we draft, and they edit. Crucially it only ever
   * FILLS the box: the sender still reads it, changes a word, and signs it, and
   * that edit is what makes the note theirs. It never sends on their behalf.
   */
  function createGiftNoteAssist(input, field) {
    const wrap = document.createElement('div');
    wrap.className = 'gift-note-assist';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-link gift-note-assist-btn';
    btn.textContent = 'Not sure what to say? Draft one for me';

    const status = document.createElement('span');
    status.className = 'gift-note-assist-status';

    btn.addEventListener('click', async () => {
      // Overwriting words someone already wrote is never worth the convenience.
      if (input.value.trim() && !confirm('Replace what you\'ve written with a new draft?')) return;

      btn.disabled = true;
      status.textContent = 'Writing…';

      try {
        const fields = PreviewRenderer.getFields();
        const res = await fetch('/api/gift-note/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            petName: fields.petName || '',
            petType: fields.petType || '',
            memory: fields.favoriteMemory || fields.personality || '',
            recipientName: fields.familyName || '',
            senderName: fields.giftFrom || '',
          }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not draft a note.');

        input.value = (data.draft || '').slice(0, field.maxLength || 600);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        status.textContent = 'Yours to change — every word.';
      } catch (err) {
        status.textContent = err.message || 'Could not draft a note. Please try again.';
      } finally {
        btn.disabled = false;
      }
    });

    wrap.appendChild(btn);
    wrap.appendChild(status);
    return wrap;
  }

  // ── Poem Section ────────────────────────────────────────────

  function createPoemSection() {
    const section = document.createElement('div');
    section.className = 'form-section poem-climax';
    section.id = 'poem-section';

    const sectionTitle = (template.formLabels && template.formLabels.poemSectionTitle) || 'Now let\'s write their tribute poem';
    const libraryLink = (template.formLabels && template.formLabels.poemLibraryLink) || 'Or choose from our poem library instead';
    const label = poemLabel();

    // Format toggle (e.g. "A poem about them" vs "A letter from them")
    const formatToggleHtml = template.poemFormats ? `
      <div class="order-type-toggle" id="poem-format-toggle" style="margin-bottom:var(--space-md)">
        ${template.poemFormats.map(f =>
          `<button class="order-type-option${f.id === poemFormat ? ' active' : ''}" data-format="${f.id}">${f.label}</button>`
        ).join('')}
      </div>` : '';

    section.innerHTML = `
      <h2 class="form-section-title">${sectionTitle}</h2>
      ${formatToggleHtml}
      <button class="poem-generate-btn" id="generate-poem-btn">
        Create Their ${label}
      </button>
      <div id="poem-result" class="poem-result" style="display:none">
        <div class="poem-version-tabs" id="poem-version-tabs" style="display:none"></div>
        <div class="poem-result-text" id="poem-result-text"></div>
        <p class="poem-afterglow" id="poem-afterglow" style="display:none"></p>
        <div class="poem-actions">
          <button class="poem-regenerate-btn" id="poem-regenerate-btn">Try another version</button>
          <button class="poem-edit-btn" id="poem-edit-btn">Edit ${label.toLowerCase()}</button>
        </div>
        <div class="regen-count" id="regen-count"></div>
      </div>
      <div id="poem-edit-area" style="display:none">
        <textarea class="poem-edit-textarea" id="poem-edit-textarea"></textarea>
        <div class="poem-actions">
          <button class="btn btn-warm btn-sm" id="poem-save-edit-btn">Save changes</button>
          <button class="poem-edit-btn" id="poem-cancel-edit-btn">Cancel</button>
        </div>
      </div>
      <div style="margin-top:var(--space-lg);text-align:center">
        <button class="poem-library-link" id="poem-library-toggle">${libraryLink}</button>
      </div>
      <div id="poem-library-area" style="display:none" class="poem-library-panel">
        <select id="poem-library-select">
          <option value="">Choose a ${label.toLowerCase()}...</option>
        </select>
        <div class="poem-library-preview" id="poem-library-preview">Select a ${label.toLowerCase()} to see a preview</div>
      </div>
    `;

    setTimeout(() => wireUpPoemSection(), 0);
    return section;
  }

  function wireUpPoemSection() {
    const generateBtn = document.getElementById('generate-poem-btn');
    const resultDiv = document.getElementById('poem-result');
    const resultText = document.getElementById('poem-result-text');
    const regenBtn = document.getElementById('poem-regenerate-btn');
    const regenCount = document.getElementById('regen-count');
    const editBtn = document.getElementById('poem-edit-btn');
    const editArea = document.getElementById('poem-edit-area');
    const editTextarea = document.getElementById('poem-edit-textarea');
    const saveEditBtn = document.getElementById('poem-save-edit-btn');
    const cancelEditBtn = document.getElementById('poem-cancel-edit-btn');
    const libraryToggle = document.getElementById('poem-library-toggle');
    const libraryArea = document.getElementById('poem-library-area');
    const librarySelect = document.getElementById('poem-library-select');
    const libraryPreview = document.getElementById('poem-library-preview');

    const nfId = nameFieldId();

    function updateGenerateButtonLabel() {
      const fields = PreviewRenderer.getFields();
      const name = fields[nfId];
      generateBtn.textContent = name
        ? `Create ${name}'s ${poemLabel()}`
        : `Create Their ${poemLabel()}`;
    }

    // Poem format toggle (poem vs letter from them). Switching formats swaps
    // in that format's own generated versions — or its generate button if
    // nothing has been generated yet — so the letter is always reachable even
    // after the poem's versions are used up.
    const formatToggle = document.getElementById('poem-format-toggle');
    if (formatToggle) {
      formatToggle.querySelectorAll('.order-type-option').forEach(btn => {
        btn.addEventListener('click', () => {
          poemFormat = btn.dataset.format;
          formatToggle.querySelectorAll('.order-type-option').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          updateGenerateButtonLabel();
          editBtn.textContent = `Edit ${poemLabel().toLowerCase()}`;
          syncPoemSectionToFormat();
          saveState();
        });
      });
    }

    const nameInput = document.getElementById(`field-${nfId}`);
    if (nameInput) {
      nameInput.addEventListener('input', updateGenerateButtonLabel);
    }

    let loadingEl = null;
    let statusTimer = null;
    let statusFadeTimer = null;

    const STATUS_ROTATE_MS = 2800;   // time each waiting line holds
    const STATUS_FADE_MS = 400;      // cross-fade between them

    /**
     * Honest waiting copy. Each line describes something that is actually
     * happening, in order, and the sequence STOPS on the last one rather than
     * looping \u2014 no invented progress, no countdown, nothing to disbelieve.
     */
    function loadingLines(name) {
      return [
        'Reading your memories\u2026',
        name ? `Finding the right words for ${name}\u2026` : 'Finding the right words\u2026',
        `Writing ${name ? name + "'s" : 'their'} ${poemLabel().toLowerCase()}\u2026`
      ];
    }

    function showPoemLoading(name) {
      const lines = loadingLines(name);

      if (!loadingEl) {
        loadingEl = document.createElement('div');
        loadingEl.className = 'poem-generating';
        loadingEl.innerHTML = `
          <div class="poem-generating-text"></div>
          <div class="poem-generating-dots"><span></span><span></span><span></span></div>
        `;
      }
      const textEl = loadingEl.querySelector('.poem-generating-text');
      clearInterval(statusTimer);
      clearTimeout(statusFadeTimer);
      textEl.classList.remove('fading');
      textEl.textContent = lines[0];

      generateBtn.style.display = 'none';
      resultDiv.style.display = 'none';
      editArea.style.display = 'none';
      const section = document.getElementById('poem-section');
      const existing = section.querySelector('.poem-generating');
      if (!existing) section.insertBefore(loadingEl, resultDiv);

      let i = 0;
      statusTimer = setInterval(() => {
        if (i >= lines.length - 1) {
          clearInterval(statusTimer);
          statusTimer = null;
          return;
        }
        i += 1;
        textEl.classList.add('fading');
        statusFadeTimer = setTimeout(() => {
          textEl.textContent = lines[i];
          textEl.classList.remove('fading');
        }, STATUS_FADE_MS);
      }, STATUS_ROTATE_MS);
    }

    function hidePoemLoading() {
      clearInterval(statusTimer);
      clearTimeout(statusFadeTimer);
      statusTimer = null;
      statusFadeTimer = null;
      if (loadingEl) {
        const textEl = loadingEl.querySelector('.poem-generating-text');
        if (textEl) textEl.classList.remove('fading');
        if (loadingEl.parentNode) loadingEl.parentNode.removeChild(loadingEl);
      }
    }

    // \u2500\u2500 Reveal pacing \u2500\u2500
    // A beat of stillness before the first line lets the loading state clear
    // and gives the moment room to land; each line then fades up gently instead
    // of popping in. Worst realistic case \u2014 a 12-line poem with two stanza
    // breaks \u2014 settles a little under 6s, so it reads as written, never waited.
    const REVEAL_FIRST_BEAT = 420;     // ms before line one
    const REVEAL_LINE_DELAY = 340;     // ms between lines
    const REVEAL_LINE_DURATION = 1000; // must match .poem-line animation in CSS

    function prefersReducedMotion() {
      return !!(window.matchMedia
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    }

    function revealPoem(poemText) {
      resultText.innerHTML = '';
      hideAfterglow();
      const lines = poemText.split('\n');

      lines.forEach((line, i) => {
        const span = document.createElement('span');
        span.className = 'poem-line';
        span.textContent = line || '\u00A0';
        span.style.animationDelay = `${REVEAL_FIRST_BEAT + i * REVEAL_LINE_DELAY}ms`;
        resultText.appendChild(span);
      });

      PreviewRenderer.setField('poemText', poemText);

      // The afterglow arrives as the last line settles \u2014 never before it, or it
      // explains the moment while the moment is still happening.
      const settleAt = prefersReducedMotion()
        ? 0
        : REVEAL_FIRST_BEAT + (lines.length - 1) * REVEAL_LINE_DELAY + REVEAL_LINE_DURATION;
      afterglowTimer = setTimeout(showAfterglow, settleAt);
    }

    /**
     * The tribute exactly as it reads on screen. During the reveal the text is
     * one <span> per line, whose combined textContent runs the lines together \u2014
     * so rebuild from the spans and put the line breaks back.
     */
    function currentPoemText() {
      const lineEls = resultText.querySelectorAll('.poem-line');
      if (!lineEls.length) return resultText.textContent;
      return Array.from(lineEls)
        .map(el => (el.textContent === '\u00A0' ? '' : el.textContent))
        .join('\n');
    }

    /**
     * Build the request body for poem generation.
     * Iterates template.memoryFields where feedsPoem: true,
     * plus adds category and templateId for server-side dispatch.
     */
    function buildPoemBody() {
      const fields = PreviewRenderer.getFields();
      const body = {
        category: template.category,
        templateId: template.id
      };

      // Always include the name field
      body[nfId] = fields[nfId] || '';

      // Gather all feedsPoem fields
      for (const mf of template.memoryFields) {
        if (mf.feedsPoem) {
          body[mf.id] = fields[mf.id] || '';
        }
      }

      // Backward compat: pet templates send legacy field names the generator expects
      if (template.category === 'pet') {
        body.petName = fields.petName || '';
        body.nicknames = fields.petNicknames || '';
      }

      // Poem format (poem vs letter from them)
      if (template.poemFormats) {
        body.format = poemFormat;
      }

      return body;
    }

    async function generatePoem() {
      const fields = PreviewRenderer.getFields();
      generateBtn.disabled = true;
      showPoemLoading(fields[nfId]);

      try {
        const res = await fetch('/api/poems/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPoemBody())
        });

        const data = await res.json();

        if (!res.ok) {
          hidePoemLoading();
          generateBtn.style.display = '';
          updateGenerateButtonLabel();
          generateBtn.disabled = false;
          alert(data.error || 'Something went wrong. Please try again.');
          return;
        }

        hidePoemLoading();
        revealPoem(data.poem);
        const history = fmtHistory();
        history.push(data.poem);
        activeIndices[fmtKey()] = history.length - 1;
        resultDiv.style.display = '';
        editArea.style.display = 'none';
        libraryArea.style.display = 'none';

        regenCounts[fmtKey()] = fmtRegenCount() + 1;
        updateRegenUi();
        updateVersionTabs();
        saveState();

        generateBtn.style.display = 'none';
      } catch (err) {
        console.error('Generation failed:', err);
        hidePoemLoading();
        updateGenerateButtonLabel();
        generateBtn.style.display = '';
      }

      generateBtn.disabled = false;
    }

    generateBtn.addEventListener('click', generatePoem);

    regenBtn.addEventListener('click', async () => {
      if (fmtRegenCount() >= MAX_REGENERATIONS) return;
      regenBtn.disabled = true;
      regenBtn.textContent = 'Writing...';

      try {
        const res = await fetch('/api/poems/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildPoemBody())
        });

        const data = await res.json();

        if (!res.ok) {
          regenBtn.textContent = 'Try another version';
          updateRegenUi();
          alert(data.error || 'Something went wrong. Please try again.');
          return;
        }

        revealPoem(data.poem);
        const history = fmtHistory();
        history.push(data.poem);
        activeIndices[fmtKey()] = history.length - 1;
        regenCounts[fmtKey()] = fmtRegenCount() + 1;
        updateVersionTabs();
        saveState();
      } catch (err) {
        console.error('Regeneration failed:', err);
      }

      regenBtn.textContent = 'Try another version';
      updateRegenUi();
    });

    editBtn.addEventListener('click', () => {
      editTextarea.value = currentPoemText();
      resultDiv.style.display = 'none';
      editArea.style.display = '';
    });

    // Pasting a long poem is exactly the moment this matters, so the note
    // follows the editor live (debounced) rather than waiting for a save.
    editTextarea.addEventListener('input', () => schedulePoemFitNote());

    saveEditBtn.addEventListener('click', () => {
      const edited = editTextarea.value.trim();
      if (edited) {
        resultText.textContent = edited;
        PreviewRenderer.setField('poemText', edited);
        const history = fmtHistory();
        const idx = activeIndices[fmtKey()];
        if (typeof idx === 'number' && idx >= 0 && idx < history.length) {
          history[idx] = edited;
        }
        saveState();
      }
      editArea.style.display = 'none';
      resultDiv.style.display = '';
    });

    cancelEditBtn.addEventListener('click', () => {
      editArea.style.display = 'none';
      resultDiv.style.display = '';
      schedulePoemFitNote();   // back to the saved poem
    });

    libraryToggle.addEventListener('click', () => {
      const showing = libraryArea.style.display !== 'none';
      libraryArea.style.display = showing ? 'none' : '';

      if (!showing && librarySelect.options.length <= 1) {
        for (const p of poems) {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = `${p.title}${p.author ? ` \u2013 ${p.author}` : ''}`;
          librarySelect.appendChild(opt);
        }
      }
    });

    librarySelect.addEventListener('change', async () => {
      if (!librarySelect.value) {
        libraryPreview.textContent = `Select a ${poemLabel().toLowerCase()} to see a preview`;
        return;
      }

      try {
        const res = await fetch(`/api/poems/${librarySelect.value}`);
        const poem = await res.json();
        libraryPreview.textContent = poem.text;

        resultText.textContent = poem.text;
        // A library poem wasn't written from their memories — never claim it was.
        hideAfterglow();
        resultDiv.style.display = '';
        editArea.style.display = 'none';
        generateBtn.style.display = 'none';

        PreviewRenderer.setField('poemText', poem.text);
        saveState();
      } catch (err) {
        libraryPreview.textContent = `Failed to load ${poemLabel().toLowerCase()}`;
      }
    });
  }

  // ── Size / Product Selector ─────────────────────────────────

  function createSizeSection() {
    const section = document.createElement('div');
    section.className = 'form-section';

    // Single-product templates: no size choice, just a clear price line.
    // A hidden selected .product-option keeps getSelectedProduct() working.
    if (template.printProducts.length === 1) {
      const product = template.printProducts[0];
      section.innerHTML = `
        <h2 class="form-section-title">Your tribute</h2>
        <div class="product-option selected" data-sku="${product.sku}" data-price="${product.price}" style="display:none">
          <span class="product-option-label">${product.label}</span>
        </div>
        <p class="single-product-line" style="font-size:1.05rem;line-height:1.5">
          <strong>$${(product.price / 100).toFixed(2)}</strong> &ndash; ${product.label}<br>
          <span style="font-size:0.88rem;color:var(--color-muted)">Their photo and poem, beautifully framed. Free shipping.</span>
        </p>
      `;
      return section;
    }

    section.innerHTML = '<h2 class="form-section-title">Choose your size</h2>';

    const grid = document.createElement('div');
    grid.className = 'product-grid';

    // Framed sizes render first and prominent; the unframed rungs (print-only,
    // digital) sit under a quiet divider, visually secondary — they exist for
    // the customer who can't stretch to a frame, never as the headline.
    let quietDividerAdded = false;
    for (const product of template.printProducts) {
      const framed = product.sku.startsWith('framed-');
      if (!framed && !quietDividerAdded) {
        const divider = document.createElement('div');
        divider.className = 'product-grid-divider';
        divider.textContent = 'Without a frame';
        grid.appendChild(divider);
        quietDividerAdded = true;
      }

      const option = document.createElement('div');
      option.className = `product-option${product.default ? ' selected' : ''}${framed ? '' : ' product-option-quiet'}`;
      option.dataset.sku = product.sku;
      option.dataset.price = product.price;
      option.innerHTML = `
        <div>
          <span class="product-option-label">${product.label}</span>
          ${product.badge ? `<span class="product-option-badge">${product.badge}</span>` : ''}
          ${product.sublabel ? `<span class="product-option-sublabel">${product.sublabel}</span>` : ''}
        </div>
        <span class="product-option-price">$${(product.price / 100).toFixed(2)}</span>
      `;

      option.addEventListener('click', () => {
        grid.querySelectorAll('.product-option').forEach(o => o.classList.remove('selected'));
        option.classList.add('selected');
        updateFrameSectionVisibility(product.sku);
        // Rebuild the frame chooser so signature frames appear/disappear with
        // the size (and a now-invalid signature choice resets to the default).
        if (isFramedSku(product.sku) && template.frameOptions) buildFrameSelector();
        updatePurchaseButton();
        // Update preview to match frame proportions
        if (PreviewRenderer && PreviewRenderer.setFrameSize) {
          PreviewRenderer.setFrameSize(product.sku);
        }
        saveState();
      });

      grid.appendChild(option);
    }

    section.appendChild(grid);
    return section;
  }

  // ── Poem Readability Note ────────────────────────────────────
  //
  // A long poem is never truncated: the tribute renderer fits it to the panel,
  // so every extra line comes out of the font size instead. Until now the
  // customer only discovered that when the proof arrived. This tells them here,
  // gently, while they can still do something about it — and the something is
  // usually just a larger size, which is honest guidance, not a nudge to spend.
  //
  // Same promise as the photo-quality message: say what we can see, never
  // block, never scold. A long poem on a small print is a perfectly good order.
  //
  // How the printed size is derived:
  //   • PreviewRenderer.measurePoemFit runs the REAL tribute renderer over an
  //     offscreen panel and reports the size the poem settled at. Nothing here
  //     re-implements the fitting, so this note can never drift from the art.
  //   • fittedFontSize / panelWidthPx is the same fraction at any scale, so
  //         printed points = fraction x panelWidthInches x 72.
  //   • The panel's printed width in inches comes from the print renderer's own
  //     geometry (see tributePanelInches).

  // Thresholds are real printed point sizes: the preview now sets verse on the
  // same 1.40 leading as the print renderer, so what this file computes tracks
  // what comes off the press to within about 5% and needs no bias correction.
  //
  // Why 8.5 and not a rounder 10: the note must always mean "your words are
  // being squeezed", never "you picked a small print". Inside its mat an 8x10
  // gives the tribute a 3x5 inch panel, which tops out at ~9.1pt even for a
  // four-line poem — so a 10pt tier would fire on every 8x10 order no matter
  // what the customer wrote, and the suggestion to size up would read as a
  // shakedown. 8.5 sits just under that ceiling, so a short poem is silent at
  // every size and the note only appears once length is genuinely the cause.
  //
  // Measured against the real renderer: an 8-12 line poem or a 10-14 line
  // letter never trips either tier at the default 11x14 in either layout.
  const POEM_COMFORT_PT = 8.5;   // below this: a gentle note
  const POEM_TIGHT_PT = 6.5;     // below this: a firmer (still warm) one
  const FIT_PROBE_W = 900;       // px — only the panel's proportions matter
  const FIT_DEBOUNCE_MS = 250;

  let poemFitTimer = null;
  let poemFitSignature = null;

  /** True when a layout prints wider than tall (mirrors the preview's own test). */
  function isLandscapeLayout(layoutKey) {
    const def = (PreviewRenderer.getLayouts() || {})[layoutKey];
    const parts = String((def && def.aspectRatio) || '1/1').split('/');
    return parseFloat(parts[0]) > parseFloat(parts[1]);
  }

  /** Physical area of a SKU in square inches, for ordering sizes. */
  function skuArea(sku) {
    const m = String(sku || '').match(/(\d+)x(\d+)/);
    return m ? Number(m[1]) * Number(m[2]) : 0;
  }

  /** "framed-11x14" → "11×14" — how a size reads inside a sentence. */
  function skuSizeLabel(sku) {
    const m = String(sku || '').match(/(\d+)x(\d+)/);
    return m ? `${m[1]}×${m[2]}` : '';
  }

  /**
   * The tribute panel's PRINTED size in inches, for a SKU and the current layout.
   *
   * SKU parsing matches printRenderer.calculatePrintDimensions exactly — the
   * convention lists the SMALLER dimension first, so a landscape layout prints
   * wider than tall (14x11 for an 11x14) and a portrait one taller than wide.
   *
   * The panel inside that print comes from tributeRenderer:
   *   • Printed-mat templates (colorMode 'auto' + printSpec) inset every
   *     opening inside the mat border and split what is left across a gutter
   *     (calculateMatLayout). Portrait: the tribute spans the full opening
   *     width and half its height; landscape: half the width, full height.
   *     That path ignores divider ratios, exactly as the print renderer does.
   *   • Everything else fills the print edge to edge (calculateLayout), split
   *     by the customer's dividers — and the preview grid IS that split, so we
   *     read the share off the laid-out panel rather than restating the maths.
   */
  function tributePanelInches(sku, layoutKey) {
    const m = String(sku || '').match(/(\d+)x(\d+)/);
    if (!m) return null;
    const landscape = isLandscapeLayout(layoutKey);
    const printW = landscape ? Number(m[2]) : Number(m[1]);
    const printH = landscape ? Number(m[1]) : Number(m[2]);

    // Whether this ORDER prints a mat is decided per order, not per template:
    // tributeRenderer.resolveOrderData sets hasPrintedMat from
    // `fields.colors && isHex(fields.colors.mat)`, and checkout posts
    // `colors: currentColors`, which stays null until a photo yields
    // auto-matched colors or the customer taps a swatch. Keying off the
    // template alone predicted the small matted panel for full-bleed orders
    // too — on an 8x10 portrait that is a 5x3" panel instead of the real
    // 8x5", under-reporting the printed size by ~40% and warning about a poem
    // that prints perfectly well. Mirror the renderer's own condition instead.
    const spec = template.printSpec;
    const printsMat = !!(currentColors && /^#[0-9a-fA-F]{6}$/.test(String(currentColors.mat || '')));
    if (printsMat && spec) {
      const border = Number(spec.matBorderIn) || 0;
      const gutter = Number(spec.gutterIn) || 0;
      const innerW = printW - border * 2;
      const innerH = printH - border * 2;
      if (innerW <= 0 || innerH <= 0) return null;
      return landscape
        ? { w: (innerW - gutter) / 2, h: innerH }
        : { w: innerW, h: (innerH - gutter) / 2 };
    }

    // Full-bleed orders split the print between the panels. For the layout the
    // customer is actually looking at, read the share off the rendered grid so
    // a dragged divider is respected. For any OTHER layout — which is how the
    // orientation suggestion asks "would turning this help?" — the DOM cannot
    // answer, because it only ever holds the current arrangement; measuring it
    // would hand back the geometry we already have and the suggestion could
    // never find a gain. Fall back to the layout's own even split, which is
    // what calculateLayout uses when no divider ratios are supplied.
    if (layoutKey === currentLayout) {
      const panelEl = document.getElementById('panel-tribute');
      const host = PreviewRenderer.getContainer && PreviewRenderer.getContainer();
      if (panelEl && host && host.clientWidth && host.clientHeight) {
        return {
          w: printW * (panelEl.clientWidth / host.clientWidth),
          h: printH * (panelEl.clientHeight / host.clientHeight),
        };
      }
    }

    const def = (template.layouts || {})[layoutKey];
    if (!def) return null;
    return landscape
      ? { w: printW / 2, h: printH }
      : { w: printW, h: printH / 2 };
  }

  /**
   * Predicted printed size of the poem, in points, at a given SKU.
   * Returns null when it cannot be computed — we never guess.
   */
  function predictedPoemPoints(sku, layoutKey, poemText) {
    if (!poemText || !PreviewRenderer.measurePoemFit) return null;
    const panel = tributePanelInches(sku, layoutKey);
    if (!panel || !(panel.w > 0) || !(panel.h > 0)) return null;

    const fit = PreviewRenderer.measurePoemFit(
      FIT_PROBE_W, FIT_PROBE_W * panel.h / panel.w, poemText);
    if (!fit || !(fit.fontSize > 0) || !(fit.panelW > 0)) return null;

    // The preview stops shrinking at its own legible floor; the print keeps
    // going, because a tribute is never clipped. When the block still overflows
    // the space it has, the size that truly fits is smaller in that proportion.
    const squeeze = (fit.blockH > 0 && fit.availH > 0)
      ? Math.min(1, fit.availH / fit.blockH)
      : 1;

    return (fit.fontSize / fit.panelW) * squeeze * panel.w * 72;
  }

  /**
   * The smallest larger size — in the same product family, so a framed order is
   * never answered with "buy the unframed one" — where these same words print
   * at a comfortable size. Null when no size we sell would actually fix it; we
   * only ever name a size the computation confirms.
   */
  /**
   * The other orientation, when simply turning the piece gives the poem room.
   *
   * This is offered BEFORE any larger size, because it is free and it is
   * usually the better fix. The two layouts hand the tribute opposite-shaped
   * panels: landscape sets it beside the photo (tall and narrow), portrait
   * stacks it beneath (wide and short). A poem is limited by how many lines
   * fit, so vertical room is what decides its size — and past about a dozen
   * lines landscape prints it up to twice as large. On an 11x14 a 24-line
   * poem is 8.4pt stacked and 16.1pt side-by-side, which beats what the next
   * size up would give for $50 more. Recommending the paid fix when the free
   * one works better is not a trade we make.
   *
   * Returns null when the current orientation is already the roomier one.
   */
  function roomierOrientationFor(sku, layoutKey, poemText) {
    const layouts = (template && template.layouts) || {};
    const keys = Object.keys(layouts);
    if (keys.length < 2) return null;

    const here = predictedPoemPoints(sku, layoutKey, poemText);
    let best = null;
    for (const key of keys) {
      if (key === layoutKey) continue;
      const points = predictedPoemPoints(sku, key, poemText);
      if (points === null || points < POEM_COMFORT_PT) continue;
      // Only worth raising if it is genuinely roomier than where they are.
      if (here !== null && points <= here) continue;
      if (best && points <= best.points) continue;
      best = { key, points, label: (layouts[key] && layouts[key].label) || key };
    }
    return best;
  }

  function roomierSizeFor(currentSku, layoutKey, poemText) {
    const products = (template && template.printProducts) || [];
    const family = String(currentSku).split('-')[0];
    const currentArea = skuArea(currentSku);
    if (!currentArea) return null;

    let best = null;
    for (const product of products) {
      if (String(product.sku).split('-')[0] !== family) continue;
      const area = skuArea(product.sku);
      if (!area || area <= currentArea) continue;
      if (best && area >= best.area) continue;
      const points = predictedPoemPoints(product.sku, layoutKey, poemText);
      if (points === null || points < POEM_COMFORT_PT) continue;
      best = { product, area, points };
    }
    return best;
  }

  /** The poem as it stands — including one still being typed in the editor. */
  function poemTextForFit() {
    const editArea = document.getElementById('poem-edit-area');
    const textarea = document.getElementById('poem-edit-textarea');
    if (editArea && editArea.style.display !== 'none' && textarea) {
      return textarea.value.trim();
    }
    const fields = PreviewRenderer.getFields();
    return fields && fields.poemText ? String(fields.poemText).trim() : '';
  }

  /** The note lives with the size chooser — where the fix is one click away. */
  function poemFitNoteHost() {
    let host = document.getElementById('poem-fit-note');
    if (host) return host;
    const anchor = document.querySelector('.product-grid')
      || document.querySelector('.single-product-line');
    if (!anchor || !anchor.parentNode) return null;
    host = document.createElement('div');
    host.id = 'poem-fit-note';
    host.className = 'poem-fit-note';
    // Politely announced, never interrupting — it arrives while they are
    // reading the sizes, not as an alert.
    host.setAttribute('role', 'status');
    host.hidden = true;
    anchor.parentNode.insertBefore(host, anchor.nextSibling);
    return host;
  }

  /** "Bailey's poem" when we know the name, "their poem" when we don't. */
  function poemSubject() {
    const fields = PreviewRenderer.getFields();
    const name = ((fields && fields[nameFieldId()]) || '').trim();
    const label = poemLabel().toLowerCase();
    return name ? `${name}'s ${label}` : `Their ${label}`;
  }

  function schedulePoemFitNote(delayMs) {
    clearTimeout(poemFitTimer);
    poemFitTimer = setTimeout(updatePoemFitNote,
      typeof delayMs === 'number' ? delayMs : FIT_DEBOUNCE_MS);
  }

  function updatePoemFitNote() {
    const host = poemFitNoteHost();
    if (!host) return;

    const product = getSelectedProduct();
    const poemText = poemTextForFit();
    const ratios = PreviewRenderer.getCurrentFrValues
      ? JSON.stringify(PreviewRenderer.getCurrentFrValues())
      : '';
    const signature = [product && product.sku, currentLayout, ratios, poemText].join('|');
    if (signature === poemFitSignature) return;
    poemFitSignature = signature;

    const hide = () => { host.hidden = true; host.innerHTML = ''; };
    if (!product || !poemText) return hide();

    const points = predictedPoemPoints(product.sku, currentLayout, poemText);
    if (points === null || points >= POEM_COMFORT_PT) return hide();

    // Prefer the free fix. Turning the piece costs the customer nothing and
    // past about a dozen lines it usually beats the next size up outright, so
    // it is offered first and a larger size is only named when orientation
    // cannot rescue the poem on its own.
    const turn = roomierOrientationFor(product.sku, currentLayout, poemText);
    const rescue = turn ? null : roomierSizeFor(product.sku, currentLayout, poemText);
    const here = skuSizeLabel(product.sku);
    const there = rescue ? skuSizeLabel(rescue.product.sku) : '';
    const turnTo = turn ? String(turn.label).toLowerCase() : '';
    const subject = poemSubject();
    const tight = points < POEM_TIGHT_PT;

    let copy;
    if (turn) {
      // Same piece, same price — the poem simply gets a taller column to sit in.
      copy = tight
        ? `${subject} runs long, and stacked under the photo it prints small `
          + `enough to be hard to read from a step back. Turned ${turnTo}, beside `
          + `the photo, the same words have room to print at a comfortable size — `
          + `same size piece, same price. Either way, you'll see a proof before `
          + `anything is made.`
        : `${subject} has a lot of lines, so in this arrangement it prints small — `
          + `every word is there, just quiet. Turned ${turnTo} the same words have `
          + `room to breathe, at the same size and price.`;
    } else if (tight && rescue) {
      copy = `${subject} runs long. On the ${here} every word still prints, but `
        + `small enough to be hard to read from a step back. On the ${there} the `
        + `same words print at a comfortable size. Either way, you'll see a proof `
        + `before anything is made.`;
    } else if (tight) {
      copy = `${subject} runs long. At this size every word still prints, but `
        + `small enough to be hard to read from a step back. Trimming a few lines `
        + `would give the rest more room. Either way, you'll see a proof before `
        + `anything is made.`;
    } else if (rescue) {
      copy = `${subject} has a lot of lines, so on the ${here} it prints small — `
        + `every word is there, just quiet. On the ${there} the same words have `
        + `room to breathe.`;
    } else {
      copy = `${subject} has a lot of lines, so at this size it prints small — `
        + `every word is there, just quiet. You'll see a proof before anything `
        + `is made.`;
    }

    host.innerHTML = '';
    host.hidden = false;
    host.classList.toggle('is-firm', tight);
    // Kept off the page, for support: what we actually computed.
    host.dataset.predictedPt = points.toFixed(1);

    const text = document.createElement('p');
    text.className = 'poem-fit-note-text';
    text.textContent = copy;
    host.appendChild(text);

    if (turn) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'poem-fit-note-action';
      button.textContent = `Turn it ${turnTo}`;
      // Straight through the layout option's own handler, exactly as if the
      // customer had chosen it — preview, selectors and saved state all follow.
      button.addEventListener('click', () => {
        const option = document.querySelector(
          `.layout-option[data-layout="${turn.key}"]`);
        if (option) option.click();
      });
      host.appendChild(button);
    } else if (rescue) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'poem-fit-note-action';
      button.textContent = `Use the ${there}`;
      // One click, through the size option's own handler, so the preview,
      // price, frame chooser and saved state all follow exactly as if the
      // customer had picked it themselves. We never change it for them.
      button.addEventListener('click', () => {
        const option = document.querySelector(
          `.product-option[data-sku="${rescue.product.sku}"]`);
        if (option) option.click();
      });
      host.appendChild(button);
    }
  }

  // ── Order Type Form Updates ──────────────────────────────────

  function updateFormForOrderType() {
    // Visibility first, and unconditionally: gift-only fields must resolve even
    // for templates that carry no giftLabels at all.
    document.querySelectorAll('[data-show-when-order-type]').forEach((el) => {
      el.style.display = el.dataset.showWhenOrderType === orderType ? '' : 'none';
    });

    // Read label maps from template.giftLabels (only pet templates have this)
    if (!template.giftLabels) return;

    const labels = template.giftLabels[orderType] || template.giftLabels['self'];
    if (!labels) return;

    for (const [fieldId, labelText] of Object.entries(labels)) {
      const labelEl = document.querySelector(`label[for="field-${fieldId}"]`);
      if (labelEl) {
        const optTag = labelEl.querySelector('span');
        labelEl.textContent = labelText;
        if (optTag) labelEl.appendChild(optTag);
      }
    }

    const personalitySub = document.querySelector('#field-personality')?.parentElement?.querySelector('.sublabel');
    const memorySub = document.querySelector('#field-favoriteMemory')?.parentElement?.querySelector('.sublabel');
    const familySub = document.querySelector('#field-familyName')?.parentElement?.querySelector('.sublabel');
    const thingSub = document.querySelector('#field-favoriteThing')?.parentElement?.querySelector('.sublabel');

    if (orderType === 'gift') {
      if (personalitySub) personalitySub.textContent = 'Anything you know about them, or skip this';
      if (memorySub) memorySub.textContent = 'A story you\'ve heard, or skip this';
      if (familySub) familySub.textContent = 'Their name or family name \u2013 this appears on the tribute';
      if (thingSub) thingSub.textContent = 'If you know it, great. If not, no worries';
    } else {
      if (personalitySub) personalitySub.textContent = 'The thing that made them uniquely yours';
      if (memorySub) memorySub.textContent = 'The one that makes you smile through tears';
      if (familySub) familySub.textContent = 'Your family name or your name';
      if (thingSub) thingSub.textContent = 'The thing they couldn\'t live without';
    }
  }

  // ── Auto-Matched Colors (swatch row) ─────────────────────────

  /** Apply a color set to the preview and remember it for checkout */
  function applyColors(colors) {
    if (!colors || (!colors.frame && !colors.mat)) return;
    currentColors = colors;
    PreviewRenderer.setColors(colors);
  }

  /**
   * Derive a full color set from a tapped swatch – frame and accent
   * (the name/dates), plus the legacy mat/bevel/text the
   * server renderer still reads. Mirror of deriveAutoColors in imageProcessor.js.
   */
  function deriveFromSwatch(hex) {
    const CM = window.ColorMath;
    const hsl = CM.hexToHsl(hex);
    const tone = CM.luminance(hex) > 0.55 ? 'light' : 'dark';

    // Legacy mat/bevel/text (kept for the server renderer until the file split)
    const matL = tone === 'dark'
      ? Math.max(0.10, Math.min(0.16, hsl.l * 0.35))
      : Math.max(0.90, Math.min(0.95, 0.85 + hsl.l * 0.1));
    const mat = CM.hslToHex({ h: hsl.h, s: hsl.s * 0.3, l: matL });
    const bevel = (autoColors && autoColors.bevel) || '#C4A882';
    let text = tone === 'dark' ? CM.mix('#FAF8F5', bevel, 0.08) : CM.mix('#2C2420', bevel, 0.08);
    if (CM.contrast(text, mat) < 4.5) text = tone === 'dark' ? '#FAF8F5' : '#2C2420';

    // Frame: rich, recognizable version of the tapped color
    const frameS = Math.max(0.22, Math.min(0.5, hsl.s));
    const frameL = CM.luminance(hex) > 0.62
      ? Math.max(0.70, Math.min(0.82, 0.70 + hsl.l * 0.12))
      : Math.max(0.28, Math.min(0.44, 0.30 + hsl.l * 0.22));
    const frame = CM.hslToHex({ h: hsl.h, s: frameS, l: frameL });

    // Accent: engraved name/dates, cream or charcoal by contrast
    const cream = '#F4ECDD';
    const dark = '#2A211B';
    const base = CM.contrast(cream, frame) >= CM.contrast(dark, frame) ? cream : dark;
    let accent = CM.mix(base, frame, 0.1);
    if (CM.contrast(accent, frame) < 4.5) accent = base;

    return { mat, bevel, text, tone, frame, accent };
  }

  /** Render the engraved-symbol picker (none / paw / heart) into the preview pane */
  function buildIconPicker() {
    const pane = document.querySelector('.preview-pane');
    if (!pane || template.colorMode !== 'auto') return;

    let picker = document.getElementById('icon-picker');
    if (!picker) {
      picker = document.createElement('div');
      picker.id = 'icon-picker';
      picker.className = 'icon-picker';
      pane.appendChild(picker);
    }

    picker.innerHTML = '<span class="icon-picker-label">Symbol</span>' +
      ICON_OPTIONS.map(o =>
        `<button type="button" class="icon-opt${o.id === frameIcon ? ' active' : ''}" data-icon="${o.id}">${o.svg}${o.label}</button>`
      ).join('');

    picker.querySelectorAll('.icon-opt').forEach(btn => {
      btn.addEventListener('click', () => {
        frameIcon = btn.dataset.icon;
        PreviewRenderer.setFrameIcon(frameIcon);
        picker.querySelectorAll('.icon-opt').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        saveState();
      });
    });
  }

  /** Pick a high-contrast engraving color (cream or charcoal) for a frame color */
  function pickAccent(frame) {
    const CM = window.ColorMath;
    const cream = '#F4ECDD';
    const dark = '#2A211B';
    const base = CM.contrast(cream, frame) >= CM.contrast(dark, frame) ? cream : dark;
    let a = CM.mix(base, frame, 0.1);
    if (CM.contrast(a, frame) < 4.5) a = base;
    return a;
  }

  /** Apply an exact custom frame color (+ optional engraving override) */
  function applyCustomColors(frameHex, accentHex) {
    const base = deriveFromSwatch(frameHex);            // legacy mat/bevel/text/tone
    const accent = accentHex || pickAccent(frameHex);
    applyColors({ ...base, frame: frameHex, accent });
  }

  /**
   * Render the color controls into #style-selector: photo-matched swatches
   * (when a photo is uploaded) plus always-available custom frame + engraving
   * color pickers.
   */
  // ── Frame Selector ───────────────────────────────────────────

  function getFrameDef(id) {
    const fo = template.frameOptions;
    if (!fo || !Array.isArray(fo.groups)) return null;
    for (const g of fo.groups) {
      const c = (g.choices || []).find(x => x.id === id);
      if (c) return Object.assign({ tier: g.tier, upchargeCents: g.upchargeCents || 0 }, c);
    }
    return null;
  }

  function frameUpchargeCents() {
    const def = getFrameDef(currentFrame);
    return def ? def.upchargeCents : 0;
  }

  function selectFrame(id) {
    const def = getFrameDef(id);
    if (!def) return;
    currentFrame = id;
    PreviewRenderer.setFrame(def);
    buildFrameSelector();
    updatePurchaseButton();
    saveState();
  }

  /** Shorter side of the selected print, in inches (for frame-size gating). */
  function selectedShortSideIn() {
    const p = getSelectedProduct();
    const m = p && p.sku.match(/(\d+)x(\d+)/);
    return m ? Math.min(parseInt(m[1], 10), parseInt(m[2], 10)) : 0;
  }

  /** Frame groups available for the current size (signature frames are gated
      to larger prints via the group's minShortSideIn). */
  function availableFrameGroups(fo) {
    const shortSide = selectedShortSideIn();
    return (fo.groups || []).filter(g => !g.minShortSideIn || shortSide >= g.minShortSideIn);
  }

  function buildFrameSelector() {
    const container = document.getElementById('style-selector');
    const fo = template.frameOptions;
    if (!container || !fo || !Array.isArray(fo.groups)) return;

    container.style.display = '';
    container.className = 'frame-selector';

    const groups = availableFrameGroups(fo);
    // If the chosen frame isn't offered at this size (e.g. a signature frame
    // after switching to a small print), fall back to the default frame.
    const allowedIds = new Set(groups.reduce((a, g) => a.concat((g.choices || []).map(c => c.id)), []));
    if (!currentFrame || !allowedIds.has(currentFrame)) {
      currentFrame = allowedIds.has(fo.default) ? fo.default
        : (groups[0] && groups[0].choices[0] && groups[0].choices[0].id);
    }

    container.innerHTML = groups.map(g => {
      const up = g.upchargeCents ? ` <span class="frame-group-up">+$${(g.upchargeCents / 100).toFixed(0)}</span>` : '';
      // The group note explains what a tier actually is — especially why the
      // signature frames cost more (they're wider, ornate, solid-wood profiles,
      // not just different colors).
      const note = g.note ? `<p class="frame-group-note">${g.note}</p>` : '';
      const chips = (g.choices || []).map(c => `
        <button type="button" class="frame-chip${c.id === currentFrame ? ' active' : ''}" data-frame="${c.id}" title="${c.label}" aria-label="${c.label}">
          <span class="frame-chip-sw" style="background:${c.swatch}"></span>
          <span class="frame-chip-label">${c.label}</span>
        </button>`).join('');
      return `<div class="frame-group"><div class="frame-group-label">${g.label}${up}</div>${note}<div class="frame-chip-row">${chips}</div></div>`;
    }).join('');

    container.querySelectorAll('.frame-chip').forEach(chip => {
      chip.addEventListener('click', () => selectFrame(chip.dataset.frame));
    });

    // Apply the current frame to the preview (idempotent).
    const def = getFrameDef(currentFrame);
    if (def) PreviewRenderer.setFrame(def);
  }

  function buildSwatchRow() {
    const container = document.getElementById('style-selector');
    if (!container || template.colorMode !== 'auto') return;

    container.style.display = '';
    container.classList.add('swatch-row');

    const photoCustom = !frameOverride && activeSwatchIndex >= 0;
    const photoRow = paletteSwatches.length ? `
      <div class="swatch-row-label">Matched to their photo</div>
      <div class="swatch-row-items">
        <button class="swatch-chip auto${activeSwatchIndex === -1 && !frameOverride ? ' active' : ''}" data-auto="1" title="Auto match">Auto</button>
        ${paletteSwatches.map((s, i) =>
          `<button class="swatch-chip${i === activeSwatchIndex && photoCustom ? ' active' : ''}" data-index="${i}" style="background:${s.hex}" title="Use this color"></button>`
        ).join('')}
      </div>` : '';

    // The frame is a fixed elegant dark wood; only the photo-matched mat colors
    // remain customer-selectable. (Freeform frame/engraving pickers removed with
    // the text-on-frame feature.)
    container.innerHTML = photoRow;

    container.querySelectorAll('.swatch-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        frameOverride = false;
        accentOverride = null;
        if (chip.dataset.auto) {
          activeSwatchIndex = -1;
          if (autoColors) applyColors(autoColors);
        } else {
          activeSwatchIndex = parseInt(chip.dataset.index, 10);
          const swatch = paletteSwatches[activeSwatchIndex];
          if (swatch) applyColors(deriveFromSwatch(swatch.hex));
        }
        buildSwatchRow();
        saveState();
      });
    });

    const frameInput = container.querySelector('#frame-color-input');
    const accentInput = container.querySelector('#accent-color-input');
    if (frameInput) {
      frameInput.addEventListener('input', () => {
        frameOverride = true;
        activeSwatchIndex = -2;
        applyCustomColors(frameInput.value, accentOverride);
        container.querySelectorAll('.swatch-chip').forEach(c => c.classList.remove('active'));
        saveState();
      });
    }
    if (accentInput) {
      accentInput.addEventListener('input', () => {
        accentOverride = accentInput.value;
        const frame = (currentColors && currentColors.frame) || (frameInput && frameInput.value) || DEFAULT_AUTO_COLORS.frame;
        applyCustomColors(frame, accentOverride);
        saveState();
      });
    }
  }

  // ── Style Variant Selector ───────────────────────────────────

  function buildStyleSelector() {
    const container = document.getElementById('style-selector');
    if (!container || !template.styleVariants) return;

    // Auto-color templates: mat/bevel colors are matched to the photo,
    // so there is no style picker (swatch row appears after upload instead).
    if (template.colorMode === 'auto') {
      container.style.display = 'none';
      return;
    }

    const thumbClasses = {
      'classic-dark': { label: 'Classic', thumbClass: 'style-thumb-dark' },
      'warm-natural': { label: 'Warm', thumbClass: 'style-thumb-warm' },
      'soft-light': { label: 'Light', thumbClass: 'style-thumb-light' }
    };

    const variants = Object.keys(template.styleVariants).map(key => ({
      key,
      label: (thumbClasses[key] && thumbClasses[key].label) || template.styleVariants[key].label || key,
      thumbClass: (thumbClasses[key] && thumbClasses[key].thumbClass) || 'style-thumb-dark'
    }));

    container.innerHTML = variants.map(v => `
      <div class="style-thumb ${v.thumbClass}${v.key === currentStyle ? ' active' : ''}" data-style="${v.key}">
        <div class="style-thumb-inner"></div>
        <span class="style-thumb-label">${v.label}</span>
      </div>
    `).join('');

    container.querySelectorAll('.style-thumb').forEach(thumb => {
      thumb.addEventListener('click', () => {
        const style = thumb.dataset.style;
        setStyle(style);
        container.querySelectorAll('.style-thumb').forEach(t => t.classList.remove('active'));
        thumb.classList.add('active');
      });
    });
  }

  function setStyle(styleKey) {
    currentStyle = styleKey;

    const frameEl = document.getElementById('frame-preview');
    if (frameEl) {
      frameEl.className = 'frame-preview theme-' + styleKey;
    }

    if (template.styleVariants[styleKey]) {
      PreviewRenderer.setStyle(template.styleVariants[styleKey]);
    }

    saveState();
  }

  // ── Purchase Flow ─────────────────────────────────────────

  function getSelectedProduct() {
    const selected = document.querySelector('.product-option.selected');
    if (!selected) return null;
    return {
      sku: selected.dataset.sku,
      price: parseInt(selected.dataset.price, 10),
      label: selected.querySelector('.product-option-label')?.textContent,
    };
  }

  /** Frames only apply to framed products (mirrors the server's guard). */
  function isFramedSku(sku) {
    return typeof sku === 'string' && sku.startsWith('framed-');
  }

  /** Hide the frame chooser for print-only/digital \u2014 no frame ships with them. */
  function updateFrameSectionVisibility(sku) {
    const container = document.getElementById('style-selector');
    if (!container || !template.frameOptions) return;
    container.style.display = isFramedSku(sku) ? '' : 'none';
    // A hidden chooser can never scroll into view — drop the hint with it.
    if (!isFramedSku(sku)) dismissFrameScrollHint();
  }

  // ── Frame-chooser scroll hint ───────────────────────────────
  // A test user never found the frame chooser: it sits below the fold (below
  // the sticky preview on mobile, at the bottom of the preview pane on short
  // desktop viewports) with nothing suggesting there is more to scroll to.
  // A small pill on the preview stage points at it, and dissolves the moment
  // the chooser is actually seen.

  let frameHintObserver = null;

  function dismissFrameScrollHint() {
    const hint = document.getElementById('frame-scroll-hint');
    if (frameHintObserver) { frameHintObserver.disconnect(); frameHintObserver = null; }
    if (!hint) return;
    hint.classList.add('dismissed');
    setTimeout(() => hint.remove(), 350);
  }

  function initFrameScrollHint() {
    const selector = document.getElementById('style-selector');
    const stage = document.querySelector('.preview-stage');
    if (!selector || !stage || !('IntersectionObserver' in window)) return;
    if (document.getElementById('frame-scroll-hint')) return;

    const hint = document.createElement('button');
    hint.type = 'button';
    hint.id = 'frame-scroll-hint';
    hint.className = 'frame-scroll-hint';
    hint.innerHTML = '<span>Scroll to choose your frame</span><span class="frame-scroll-hint-chev">⌄</span>';
    hint.addEventListener('click', () => {
      selector.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    stage.appendChild(hint);

    frameHintObserver = new IntersectionObserver((entries) => {
      if (entries.some(e => e.isIntersecting)) dismissFrameScrollHint();
    }, { threshold: 0.6 });
    frameHintObserver.observe(selector);
  }

  function updatePurchaseButton() {
    const btn = document.getElementById('purchase-btn');
    if (!btn) return;
    const product = getSelectedProduct();
    if (product) {
      // The frame upcharge only exists on framed products \u2014 the server
      // charges 0 for print-only/digital, so the button must agree.
      const upcharge = isFramedSku(product.sku) ? frameUpchargeCents() : 0;
      const total = product.price + upcharge;
      btn.textContent = `Continue to Checkout \u2013 $${(total / 100).toFixed(2)}`;
    }
  }

  /**
   * The one description of the order the server needs. Both the proof request
   * and the checkout request post exactly this — the proof the customer
   * approves is rendered from the same description that goes on to print.
   */
  function buildOrderBody(product, fields, poemText) {
    return {
      templateId: TEMPLATE_ID,
      sku: product.sku,
      fields,
      poemText: poemText.trim(),
      style: currentStyle,
      layout: currentLayout,
      orderType,
      colors: currentColors,
      frameIcon,
      frameChoice: currentFrame,
      poemFirst,
      // What the customer framed on screen must be what prints: the
      // divider-drag panel ratios and each photo's zoom/pan. The server
      // sanitizes both and its renderers reproduce them exactly.
      customRatios: PreviewRenderer.getCurrentFrValues(),
      photoCrops: {
        photo: PreviewRenderer.getPhotoCrop('photo'),
        panel2: PreviewRenderer.getPhotoCrop('panel2'),
      },
    };
  }

  /**
   * Real checkout intent — GA4 + Meta with the true order value. Fired when
   * the customer approves their proof and heads for payment, not when they
   * ask to see the proof. (The marketing pages' CTA-click event is
   * top-of-funnel only; this is the one that carries the amount they pay.)
   */
  function fireCheckoutAnalytics(product) {
    try {
      const upcharge = isFramedSku(product.sku) ? frameUpchargeCents() : 0;
      const value = (product.price + upcharge) / 100;
      if (typeof gtag === 'function') {
        gtag('event', 'begin_checkout', { currency: 'USD', value });
      }
      if (typeof fbq === 'function' && window.SBM_ENV && window.SBM_ENV.metaPixelId) {
        fbq('track', 'InitiateCheckout', { currency: 'USD', value });
      }
    } catch (e) { /* analytics must never block checkout */ }
  }

  /** POST JSON with a hard timeout, so nothing can hang silently forever. */
  async function postJson(url, body, timeoutMs) {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    if (ctrl && timeoutMs) timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined,
      });
      let data = {};
      try { data = await res.json(); } catch (e) { data = {}; }
      return { ok: res.ok, data: data || {} };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function handlePurchase() {
    const product = getSelectedProduct();

    if (!product) {
      alert('Please select a size.');
      return;
    }

    const fields = PreviewRenderer.getFields();
    const poemText = fields.poemText;

    if (!poemText || !poemText.trim()) {
      alert('Please generate or select a poem before purchasing.');
      return;
    }

    // A gift ships white-label to the recipient, so without a "from" the box
    // is anonymous — they'd have no idea which friend sent it. The note stays
    // optional; the sender's name does not.
    if (orderType === 'gift' && !(fields.giftFrom || '').trim()) {
      alert('Please add your name so they know who this gift is from.');
      const el = document.getElementById('field-giftFrom');
      if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.focus(); }
      return;
    }

    if (proofBusy || proofOpen) return;   // one proof at a time

    // Ask for the real, watermarked proof of this exact piece. Compositing it
    // takes a few seconds, so the button says so rather than sitting dead.
    // The body is built once and kept: the proof they approve and the order
    // that goes to Stripe describe the same piece, byte for byte.
    const orderBody = buildOrderBody(product, fields, poemText);
    proofBusy = true;
    setPurchaseButtonBusy(true);
    setProofNote('Setting your words into the frame. This takes a few seconds.', 'wait');

    try {
      const { ok, data } = await postJson('/api/checkout/proof', orderBody, PROOF_TIMEOUT_MS);

      if (!ok || !data.orderId || !data.proofUrl) {
        setProofNote(data.error ||
          'We couldn’t finish your proof just now. Nothing has been charged, and everything you’ve made is exactly as you left it — please try again in a moment.',
          'error');
        return;
      }

      clearProofNote();
      proofOrder = {
        orderId: data.orderId,
        proofUrl: data.proofUrl,
        body: orderBody,
        product,
        petName: (fields[nameFieldId()] || '').trim(),
        analyticsFired: false,
      };
      openProofDialog();
    } catch (err) {
      console.error('Proof error:', err);
      const aborted = err && (err.name === 'AbortError' || err.code === 20);
      setProofNote(aborted
        ? 'That took longer than it should have. Nothing has been charged and your piece is exactly as you left it — please try again.'
        : 'We couldn’t connect just now. Nothing has been charged — check your connection and try again in a moment.',
        'error');
    } finally {
      proofBusy = false;
      setPurchaseButtonBusy(false);
    }
  }

  // ── Proof approval ─────────────────────────────────────────
  // The last thing before payment: the customer's real, watermarked proof,
  // shown large enough to read, with one tick that sends it to print. There is
  // no email round-trip — what they approve here is what is made.

  const PROOF_TIMEOUT_MS = 60000;      // proof compositing runs server-side
  const CHECKOUT_TIMEOUT_MS = 30000;

  const PROOF_FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), ' +
    'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  const proofReduceMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  let proofEls = null;          // dialog nodes, built on first use
  let proofOrder = null;        // { orderId, proofUrl, body, product, petName }
  let proofOpen = false;
  let proofBusy = false;        // proof request in flight
  let proofSubmitting = false;  // checkout request in flight (dialog is locked)
  let proofLastFocus = null;
  let proofPrevOverflow = '';
  let proofPrevPadRight = '';
  let proofCloseTimer = null;

  /** The purchase button never looks dead: it says what it is doing. */
  function setPurchaseButtonBusy(on) {
    const btn = document.getElementById('purchase-btn');
    if (!btn) return;
    if (on) {
      btn.disabled = true;
      btn.setAttribute('aria-busy', 'true');
      btn.classList.add('is-preparing');
      btn.textContent = 'Preparing your proof…';
    } else {
      btn.disabled = false;
      btn.removeAttribute('aria-busy');
      btn.classList.remove('is-preparing');
      btn.textContent = 'Continue to Checkout';
      updatePurchaseButton();
    }
  }

  function setProofNote(message, kind) {
    const note = document.getElementById('proof-note');
    if (!note) return;
    note.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    note.classList.toggle('is-error', kind === 'error');
    note.classList.toggle('is-wait', kind === 'wait');
    note.textContent = message;
    note.hidden = false;
  }

  function clearProofNote() {
    const note = document.getElementById('proof-note');
    if (!note) return;
    note.textContent = '';
    note.hidden = true;
    note.classList.remove('is-error', 'is-wait');
  }

  function setProofStatus(message, kind) {
    if (!proofEls) return;
    proofEls.status.classList.toggle('is-error', kind === 'error');
    proofEls.status.textContent = message || '';
  }

  function buildProofDialog() {
    const root = document.createElement('div');
    root.className = 'pf-root';
    root.id = 'proof-approval';
    root.hidden = true;

    const dialog = document.createElement('div');
    dialog.className = 'pf-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'pf-title');
    dialog.setAttribute('tabindex', '-1');

    // Static skeleton only — every piece of customer text (their pet's name)
    // is written with textContent below, never through innerHTML.
    dialog.innerHTML = `
      <button type="button" class="pf-close" id="pf-close" aria-label="Close and keep editing">
        <span class="pf-x" aria-hidden="true">&times;</span>
      </button>
      <div class="pf-scroll" id="pf-scroll">
        <div class="pf-head">
          <p class="pf-eyebrow">Your proof</p>
          <h2 class="pf-title" id="pf-title"></h2>
          <p class="pf-lede" id="pf-lede"></p>
        </div>
        <div class="pf-frame" id="pf-frame">
          <p class="pf-loading" id="pf-loading">
            <span class="pf-spinner" aria-hidden="true"></span>
            <span>Bringing your proof in…</span>
          </p>
          <img class="pf-img" id="pf-img" alt="" decoding="async">
        </div>
        <div class="pf-tools">
          <button type="button" class="pf-zoom" id="pf-zoom" aria-pressed="false">Zoom in to read</button>
        </div>
      </div>
      <div class="pf-foot">
        <div class="pf-approve">
          <label class="pf-check" for="pf-agree">
            <input type="checkbox" id="pf-agree">
            <span class="pf-check-text" id="pf-agree-text"></span>
          </label>
          <p class="pf-final" id="pf-final">This is the final version. Once you tick the box and continue, it goes to print exactly as you see it here — the words, the photo and the layout stay as they are. If anything isn’t right, keep editing and we’ll make you a new proof.</p>
        </div>
        <div class="pf-actions">
          <button type="button" class="pf-confirm" id="pf-confirm" aria-describedby="pf-final" disabled></button>
          <button type="button" class="pf-back" id="pf-back">Keep editing</button>
          <p class="pf-nudge" id="pf-nudge">Tick the box above when you’re ready.</p>
        </div>
      </div>
      <p class="pf-status" id="pf-status" role="status" aria-live="polite"></p>
    `;

    root.appendChild(dialog);
    document.body.appendChild(root);

    const els = {
      root,
      dialog,
      close: dialog.querySelector('#pf-close'),
      scroll: dialog.querySelector('#pf-scroll'),
      title: dialog.querySelector('#pf-title'),
      lede: dialog.querySelector('#pf-lede'),
      frame: dialog.querySelector('#pf-frame'),
      loading: dialog.querySelector('#pf-loading'),
      img: dialog.querySelector('#pf-img'),
      zoom: dialog.querySelector('#pf-zoom'),
      agree: dialog.querySelector('#pf-agree'),
      agreeText: dialog.querySelector('#pf-agree-text'),
      confirm: dialog.querySelector('#pf-confirm'),
      back: dialog.querySelector('#pf-back'),
      nudge: dialog.querySelector('#pf-nudge'),
      status: dialog.querySelector('#pf-status'),
    };

    els.close.addEventListener('click', () => closeProofDialog());
    els.back.addEventListener('click', () => closeProofDialog());
    els.confirm.addEventListener('click', confirmProof);
    els.zoom.addEventListener('click', () => toggleProofZoom());
    els.img.addEventListener('click', () => toggleProofZoom());

    els.agree.addEventListener('change', () => {
      // Nothing is approved until this is ticked, so nothing can be paid for.
      els.confirm.disabled = !els.agree.checked || els.agree.disabled;
      els.nudge.hidden = els.agree.checked;
      if (els.agree.checked) setProofStatus('');
    });

    els.img.addEventListener('load', () => {
      els.loading.hidden = true;
      els.agree.disabled = false;
      setProofStatus('Your proof is ready to read.');
    });
    els.img.addEventListener('error', () => {
      els.loading.hidden = true;
      els.agree.disabled = true;
      els.confirm.disabled = true;
      setProofStatus('Your proof didn’t come through. Keep editing and tap Continue to Checkout again — nothing has been charged.', 'error');
    });

    // Backdrop click closes, but only when the press starts AND ends on the
    // backdrop — so a drag out of the proof image never dismisses it.
    let pressedBackdrop = false;
    root.addEventListener('mousedown', (e) => { pressedBackdrop = (e.target === root); });
    root.addEventListener('click', (e) => {
      if (e.target === root && pressedBackdrop) closeProofDialog();
      pressedBackdrop = false;
    });

    // Keys are handled here and stopped here. store.js listens for Escape on
    // document to dismiss its exit-intent popup, and the preview zoom above
    // does the same — letting our Escape bubble would fire both.
    dialog.addEventListener('keydown', onProofKeydown);

    return els;
  }

  function onProofKeydown(e) {
    if (!proofOpen) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      closeProofDialog();
    } else if (e.key === 'Tab') {
      trapProofTab(e);
    }
  }

  function trapProofTab(e) {
    const items = [];
    const nodes = proofEls.dialog.querySelectorAll(PROOF_FOCUSABLE);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (!n.hasAttribute('hidden') && n.offsetParent !== null) items.push(n);
    }
    if (!items.length) {
      e.preventDefault();
      proofEls.dialog.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || active === proofEls.dialog || !proofEls.dialog.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  // Focus can still escape via a find-bar or an errant script; pull it back.
  function onProofFocusIn(e) {
    if (proofOpen && proofEls && !proofEls.dialog.contains(e.target)) {
      e.stopPropagation();
      proofEls.dialog.focus();
    }
  }

  function toggleProofZoom(force) {
    if (!proofEls) return;
    const on = typeof force === 'boolean' ? force : !proofEls.frame.classList.contains('is-zoomed');
    proofEls.frame.classList.toggle('is-zoomed', on);
    proofEls.zoom.setAttribute('aria-pressed', on ? 'true' : 'false');
    proofEls.zoom.textContent = on ? 'Fit the whole piece on screen' : 'Zoom in to read';
    if (!on) { proofEls.frame.scrollTop = 0; proofEls.frame.scrollLeft = 0; }
  }

  function openProofDialog() {
    if (!proofOrder) return;
    if (!proofEls) proofEls = buildProofDialog();
    const els = proofEls;
    const name = proofOrder.petName;
    const product = proofOrder.product;
    const upcharge = isFramedSku(product.sku) ? frameUpchargeCents() : 0;
    const total = (product.price + upcharge) / 100;

    els.title.textContent = name
      ? name + '’s tribute, exactly as it will print'
      : 'Your tribute, exactly as it will print';
    els.lede.textContent = 'Take your time with it. Read it the way you’d read a letter — every word, the dates, the spelling of their name. The pale watermark is only on this proof; it never appears on the piece that comes to you.';
    els.agreeText.textContent = name
      ? 'I’ve read every word of ' + name + '’s tribute. Print it exactly as it is here.'
      : 'I’ve read every word. Print it exactly as it is here.';
    els.confirm.textContent = 'Approve & continue – $' + total.toFixed(2);
    els.img.alt = name
      ? 'Watermarked proof of ' + name + '’s tribute'
      : 'Watermarked proof of your tribute';

    // Every opening starts from unticked and unread.
    els.agree.checked = false;
    els.agree.disabled = true;
    els.confirm.disabled = true;
    els.confirm.removeAttribute('aria-busy');
    els.confirm.classList.remove('is-busy');
    els.back.disabled = false;
    els.close.disabled = false;
    els.nudge.hidden = false;
    els.loading.hidden = false;
    toggleProofZoom(false);
    setProofStatus('');
    els.img.removeAttribute('src');
    els.img.src = proofOrder.proofUrl;

    if (proofCloseTimer) { clearTimeout(proofCloseTimer); proofCloseTimer = null; }
    // The dialog is always opened from the purchase button, and a disabled
    // button has already dropped focus by now — so aim the restore there.
    proofLastFocus = document.getElementById('purchase-btn') || document.activeElement;
    proofOpen = true;
    proofSubmitting = false;

    // Lock the page behind the dialog, compensating for the scrollbar so the
    // layout underneath does not jump sideways.
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    proofPrevOverflow = document.body.style.overflow;
    proofPrevPadRight = document.body.style.paddingRight;
    document.body.style.overflow = 'hidden';
    if (sbw > 0) {
      const basePad = parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
      document.body.style.paddingRight = (basePad + sbw) + 'px';
    }
    document.body.classList.add('pf-open');

    els.root.hidden = false;
    document.addEventListener('focusin', onProofFocusIn, true);

    void els.root.offsetWidth;    // force reflow so the fade actually runs
    els.root.classList.add('is-open');

    els.scroll.scrollTop = 0;
    els.dialog.focus();
  }

  /**
   * Backing out costs nothing: the customizer is untouched underneath, the
   * purchase button goes back to normal, and the next attempt renders a fresh
   * proof of whatever they changed in the meantime.
   */
  function closeProofDialog() {
    if (!proofOpen || proofSubmitting) return;
    const els = proofEls;
    proofOpen = false;

    document.removeEventListener('focusin', onProofFocusIn, true);
    els.root.classList.remove('is-open');
    document.body.classList.remove('pf-open');
    document.body.style.overflow = proofPrevOverflow;
    document.body.style.paddingRight = proofPrevPadRight;

    const finish = () => {
      proofCloseTimer = null;
      if (proofOpen) return;                 // reopened during the fade-out
      els.root.hidden = true;
      els.img.removeAttribute('src');        // release the proof JPEG
    };
    if (proofReduceMotion.matches) finish();
    else proofCloseTimer = setTimeout(finish, 220);

    proofOrder = null;               // a new proof for every new attempt
    setPurchaseButtonBusy(false);    // never leave them stuck on a dead button
    clearProofNote();

    if (proofLastFocus && document.contains(proofLastFocus)) {
      try { proofLastFocus.focus(); } catch (err) { /* element went away */ }
    } else {
      const btn = document.getElementById('purchase-btn');
      if (btn) btn.focus();
    }
    proofLastFocus = null;
  }

  async function confirmProof() {
    const els = proofEls;
    if (!els || !proofOrder || proofSubmitting) return;
    if (!els.agree.checked) return;

    if (!proofOrder.analyticsFired) {
      fireCheckoutAnalytics(proofOrder.product);
      proofOrder.analyticsFired = true;
    }

    const label = els.confirm.textContent;
    proofSubmitting = true;
    els.confirm.disabled = true;
    els.confirm.setAttribute('aria-busy', 'true');
    els.confirm.classList.add('is-busy');
    els.confirm.textContent = 'Taking you to secure payment…';
    els.back.disabled = true;
    els.close.disabled = true;
    setProofStatus('Approved. Opening secure payment…');

    try {
      const body = Object.assign({}, proofOrder.body, {
        orderId: proofOrder.orderId,
        approved: true,
      });
      const { ok, data } = await postJson('/api/checkout', body, CHECKOUT_TIMEOUT_MS);

      if (!ok || !data.checkoutUrl) {
        restoreProofConfirm(label);
        setProofStatus(data.error ||
          'We couldn’t reach secure payment just now. Nothing has been charged and your approval is still here — please try again.',
          'error');
        return;
      }

      window.location.href = data.checkoutUrl;
    } catch (err) {
      console.error('Checkout error:', err);
      restoreProofConfirm(label);
      setProofStatus('We couldn’t reach secure payment just now. Nothing has been charged and your approval is still here — please try again.', 'error');
    }
  }

  function restoreProofConfirm(label) {
    const els = proofEls;
    proofSubmitting = false;
    els.confirm.textContent = label;
    els.confirm.classList.remove('is-busy');
    els.confirm.removeAttribute('aria-busy');
    els.confirm.disabled = !els.agree.checked;
    els.back.disabled = false;
    els.close.disabled = false;
  }

  // ── State Persistence ──────────────────────────────────────

  function saveState() {
    try {
      const state = {
        templateId: TEMPLATE_ID,
        fields: PreviewRenderer.getFields(),
        style: currentStyle,
        layout: currentLayout,
        orderType,
        poemHistories,
        activeIndices,
        regenCounts,
        poemFormat,
        photoCrop: PreviewRenderer.getPhotoCrop('photo'),
        panel2Crop: PreviewRenderer.getPhotoCrop('panel2'),
        thirdPanelEnabled,
        thirdPanelType,
        currentColors,
        autoColors,
        paletteSwatches,
        activeSwatchIndex,
        frameOverride,
        accentOverride,
        frameIcon,
        frameChoice: currentFrame,
        poemFirst,
        customRatios: PreviewRenderer.getCustomRatios(),
        selectedProduct: document.querySelector('.product-option.selected .product-option-label')?.textContent,
        selectedSku: document.querySelector('.product-option.selected')?.dataset?.sku,
        timestamp: Date.now()
      };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch (e) {
      // sessionStorage may not be available
    }

    // Every meaningful change lands here — poem, size, layout, dividers — so
    // this is the one place the readability note needs to listen. It debounces
    // and skips the work entirely when nothing it depends on actually moved.
    schedulePoemFitNote();
  }

  function restoreState() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return;

      const state = JSON.parse(raw);
      if (state.templateId !== TEMPLATE_ID) return;

      // Restore fields
      if (state.fields) {
        for (const [fieldId, value] of Object.entries(state.fields)) {
          if (fieldId === 'poemText') continue;
          const input = document.getElementById(`field-${fieldId}`);
          if (input && value) {
            input.value = value;
            PreviewRenderer.setField(fieldId, value);

            const count = document.getElementById(`count-${fieldId}`);
            if (count) count.textContent = value.length;
          }
        }

        // Restore poem text into the preview; the poem SECTION is synced to the
        // active format further down (after format + histories are restored).
        if (state.fields.poemText) {
          PreviewRenderer.setField('poemText', state.fields.poemText);
          // No generated history means this text came from the poem library —
          // show it directly (the per-format sync below won't run).
          const hasHistory = (state.poemHistories && Object.keys(state.poemHistories).length > 0)
            || (state.poemHistory && state.poemHistory.length > 0);
          if (!hasHistory) {
            const resultDiv = document.getElementById('poem-result');
            const resultText = document.getElementById('poem-result-text');
            const generateBtn = document.getElementById('generate-poem-btn');
            if (resultDiv && resultText) {
              resultText.textContent = state.fields.poemText;
              resultDiv.style.display = '';
              generateBtn.style.display = 'none';
            }
          }
        }

        // Restore per-format histories and budgets. Older saved states carry a
        // single flat poemHistory + regenerationCount — credit those to the
        // saved format so nobody gets surprise extra generations on reload.
        if (state.poemHistories && typeof state.poemHistories === 'object') {
          poemHistories = state.poemHistories;
          activeIndices = state.activeIndices || {};
          regenCounts = state.regenCounts || {};
        } else if (state.poemHistory && state.poemHistory.length > 0) {
          const legacyKey = state.poemFormat || 'poem';
          poemHistories[legacyKey] = state.poemHistory;
          activeIndices[legacyKey] = typeof state.activePoemIndex === 'number' && state.activePoemIndex >= 0
            ? state.activePoemIndex
            : state.poemHistory.length - 1;
          regenCounts[legacyKey] = state.regenerationCount || state.poemHistory.length;
        }
      }

      // Restore custom ratios
      if (state.customRatios) {
        for (const [key, ratios] of Object.entries(state.customRatios)) {
          PreviewRenderer.setCustomRatios(key, ratios.columns, ratios.rows);
        }
      }

      // Restore third panel state (only if this template still supports it)
      if (state.thirdPanelEnabled && hasThreePanelLayouts()) {
        thirdPanelEnabled = true;
        thirdPanelType = state.thirdPanelType || 'photo';
      }

      // Restore layout (validate against current template — saved state may
      // reference a layout that no longer exists)
      if (state.layout && !(template.layouts && template.layouts[state.layout])) {
        state.layout = template.defaultLayout || null;
      }
      if (state.layout) {
        currentLayout = state.layout;
        PreviewRenderer.setLayout(state.layout);
        rebuildLayoutSelector();

        if (thirdPanelEnabled) {
          const secondSection = document.getElementById('second-photo-section');
          if (secondSection && thirdPanelType === 'photo') secondSection.style.display = '';
          updatePanelToggle();
          requestAnimationFrame(() => initPhotoCropInteraction('panel2'));
        }
      }

      // Restore photo crops
      if (state.photoCrop) {
        PreviewRenderer.setPhotoCrop('photo',
          state.photoCrop.zoom || 1,
          state.photoCrop.panX || 0.5,
          state.photoCrop.panY || 0.5
        );
      }
      if (state.panel2Crop) {
        PreviewRenderer.setPhotoCrop('panel2',
          state.panel2Crop.zoom || 1,
          state.panel2Crop.panX || 0.5,
          state.panel2Crop.panY || 0.5
        );
      }

      // Restore poem format (validate against template formats)
      if (state.poemFormat && template.poemFormats
          && template.poemFormats.some(f => f.id === state.poemFormat)) {
        poemFormat = state.poemFormat;
        const ft = document.getElementById('poem-format-toggle');
        if (ft) {
          ft.querySelectorAll('.order-type-option').forEach(b =>
            b.classList.toggle('active', b.dataset.format === poemFormat));
        }
      }

      // Point the poem section at the restored format's own content/budget.
      // (Wired via setTimeout(0) in createPoemSection, so defer one tick.)
      if (Object.keys(poemHistories).length > 0) {
        setTimeout(() => syncPoemSectionToFormat(), 50);
      }

      // Restore auto-matched colors (colorMode: 'auto' templates)
      if (template.colorMode === 'auto' && state.currentColors && state.currentColors.mat) {
        autoColors = state.autoColors || null;
        paletteSwatches = state.paletteSwatches || [];
        activeSwatchIndex = typeof state.activeSwatchIndex === 'number' ? state.activeSwatchIndex : -1;
        frameOverride = !!state.frameOverride;
        accentOverride = state.accentOverride || null;
        applyColors(state.currentColors);
        buildSwatchRow();
      }

      // Restore style (validate against current template variants)
      if (state.style && !(template.styleVariants && template.styleVariants[state.style])) {
        state.style = null;
      }
      if (state.frameChoice && getFrameDef(state.frameChoice)) {
        currentFrame = state.frameChoice;
        buildFrameSelector();
        updatePurchaseButton();
      }
      if (state.poemFirst) {
        poemFirst = true;
        PreviewRenderer.setPoemPosition(true);
        const flipBtn = document.getElementById('poem-flip-btn');
        if (flipBtn) flipBtn.classList.add('active');
      }
      if (state.style && state.style !== currentStyle) {
        setStyle(state.style);
        const thumbs = document.querySelectorAll('.style-thumb');
        thumbs.forEach(t => {
          t.classList.toggle('active', t.dataset.style === state.style);
        });
      }

      // Restore order type (only relevant for templates with giftLabels)
      if (template.giftLabels && state.orderType && state.orderType !== orderType) {
        orderType = state.orderType;
        const toggleBtns = document.querySelectorAll('.order-type-option');
        toggleBtns.forEach(b => b.classList.toggle('active', b.dataset.type === orderType));
        const hint = document.getElementById('order-type-hint');
        if (hint) {
          hint.textContent = orderType === 'gift'
            ? 'You\'re creating a meaningful gift \u2013 we\'ll guide you through it.'
            : 'Each detail helps us write their tribute.';
        }
        updateFormForOrderType();
      }

      // Restore selected product
      if (state.selectedProduct) {
        document.querySelectorAll('.product-option').forEach(opt => {
          const label = opt.querySelector('.product-option-label');
          if (label && label.textContent === state.selectedProduct) {
            document.querySelectorAll('.product-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
          }
        });
      }

      // Re-attach divider handles after restore
      requestAnimationFrame(() => attachDividerHandles());
    } catch (e) {
      // Ignore restore errors
    }
  }

  // ── Preview zoom (magnifier for small tribute text) ─────────

  // On mobile the framed preview floats: big at the top of the flow, then it
  // shrinks to a compact thumbnail pinned under the header once you scroll into
  // the form — so the tribute stays visible and updates live as you type.
  function initMobilePreviewPin() {
    const stage = document.querySelector('.preview-stage');
    if (!stage) return;
    const mq = window.matchMedia('(max-width: 1024px)');
    let ticking = false;
    function apply() {
      ticking = false;
      if (!mq.matches) { stage.classList.remove('mini'); return; }
      stage.classList.toggle('mini', window.scrollY > 200);
    }
    window.addEventListener('scroll', () => {
      if (!ticking) { ticking = true; requestAnimationFrame(apply); }
    }, { passive: true });
    if (mq.addEventListener) mq.addEventListener('change', apply);
    apply();
  }

  function initPreviewZoom() {
    const btn = document.getElementById('preview-zoom-btn');
    const pane = document.querySelector('.preview-pane');
    if (!btn || !pane) return;

    function setZoom(on) {
      pane.classList.toggle('zoomed', on);
      document.body.classList.toggle('preview-zoom-open', on);
      btn.innerHTML = on ? '&#10005; Close' : '&#128269; Zoom in to read';
      // Re-render the canvases at the new layout size so the poem text
      // is redrawn crisp at the larger scale instead of stretched.
      window.dispatchEvent(new Event('resize'));
      if (on) pane.scrollTop = 0;
    }

    btn.addEventListener('click', () => setZoom(!pane.classList.contains('zoomed')));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pane.classList.contains('zoomed')) setZoom(false);
    });
  }

  function initPoemFlip() {
    const btn = document.getElementById('poem-flip-btn');
    if (!btn) return;
    btn.addEventListener('click', () => {
      poemFirst = !poemFirst;
      PreviewRenderer.setPoemPosition(poemFirst);
      btn.classList.toggle('active', poemFirst);
      saveState();
    });
  }

  // ── Start ──────────────────────────────────────────────────

  init();
  initPreviewZoom();
  initPoemFlip();
  initMobilePreviewPin();

})();
