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
  let regenerationCount = 0;
  let poemHistory = [];       // up to 3 generated poems
  let activePoemIndex = -1;   // which version is showing
  let currentStyle = 'classic-dark';
  let currentLayout = 'side-by-side';
  let orderType = 'self'; // 'self' or 'gift'
  let thirdPanelEnabled = false;
  let thirdPanelType = 'photo'; // 'photo' or 'text'

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
    return (template && template.poemLabel) || 'Poem';
  }

  // ── Poem Version History (module-level so both wireUp and restore can use) ──

  function updateVersionTabs() {
    const vt = document.getElementById('poem-version-tabs');
    if (!vt) return;
    if (poemHistory.length < 2) {
      vt.style.display = 'none';
      return;
    }
    vt.style.display = '';
    vt.innerHTML = poemHistory.map((_, i) =>
      `<button class="poem-version-tab${i === activePoemIndex ? ' active' : ''}" data-index="${i}">Version ${i + 1}</button>`
    ).join('');
    vt.querySelectorAll('.poem-version-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        showPoemVersion(parseInt(tab.dataset.index));
      });
    });
  }

  function showPoemVersion(index) {
    if (index < 0 || index >= poemHistory.length) return;
    activePoemIndex = index;
    const rt = document.getElementById('poem-result-text');
    if (rt) rt.textContent = poemHistory[index];
    PreviewRenderer.setField('poemText', poemHistory[index]);
    updateVersionTabs();
    saveState();
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

      // Wire up photo crop interaction for main photo panel
      initPhotoCropInteraction('photo');

      // Build the guided form
      buildGuidedForm();

      // Build layout & style selectors (dynamic)
      rebuildLayoutSelector();
      buildStyleSelector();
      buildPanelToggle();

      // Restore saved state
      restoreState();

      // Set initial frame size from selected product
      const initialProduct = document.querySelector('.product-option.selected');
      if (initialProduct && initialProduct.dataset.sku && PreviewRenderer.setFrameSize) {
        PreviewRenderer.setFrameSize(initialProduct.dataset.sku);
      }

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
          updateFormLabelsForOrderType();
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

    // Gift-mode helper note (only for templates with giftLabels)
    if (template.giftLabels) {
      const giftNote = document.createElement('p');
      giftNote.id = 'gift-detail-note';
      giftNote.className = 'gift-detail-note';
      giftNote.textContent = 'Share what you know. The more details, the more personal the ' + poemLabel().toLowerCase() + ' \u2013 but even just a name and photo make a beautiful tribute.';
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
        Purchase
      </button>
      <p style="text-align:center;margin-top:0.5rem;font-size:0.85rem;color:var(--color-muted)">
        Free shipping. Museum-quality framed print.
      </p>
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
        <input type="file" id="upload-input-${slot.id}" accept="image/jpeg,image/png,image/webp,image/heic,image/heif" capture="environment">
      </div>
    `;

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

    const localUrl = URL.createObjectURL(file);
    photoUploaded[panelId] = true;
    PreviewRenderer.setPhoto(panelId, localUrl, '50% 50%');

    showUploadPreview(slotId, localUrl, wrapper, 'Uploading...');

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

    if (existing) {
      existing.querySelector('img').src = imageUrl;
    } else {
      const preview = document.createElement('div');
      preview.className = 'upload-preview';
      preview.innerHTML = `
        <img src="${imageUrl}" alt="Uploaded photo">
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
      cropHint.textContent = 'Drag the preview to reposition. Scroll to zoom.';
      wrapper.appendChild(cropHint);
    }

    if (quality) {
      if (quality.tier === 'low') {
        const msg = document.createElement('p');
        msg.className = 'quality-message';
        msg.textContent = 'This photo is lower resolution, but don\'t worry \u2013 our team will upscale and enhance it for the best possible print.';
        wrapper.appendChild(msg);
      } else if (quality.tier === 'usable') {
        const msg = document.createElement('p');
        msg.className = 'quality-message';
        msg.textContent = 'Good enough to work with. We\'ll upscale and optimize it for a sharp, lasting print.';
        wrapper.appendChild(msg);
      }

      const assurance = document.createElement('p');
      assurance.className = 'photo-assurance';
      assurance.innerHTML = '&#10003; Every photo is reviewed and enhanced by a professional photographer before printing';
      wrapper.appendChild(assurance);
    }
  }

  // ── Photo Crop Interaction (drag to pan, scroll to zoom) ────

  function initPhotoCropInteraction(panelId) {
    const canvas = PreviewRenderer.getPhotoCanvas(panelId);
    if (!canvas) return;

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
      canvas.style.cursor = 'grabbing';
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
        canvas.style.cursor = 'grab';
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
      saveState();
    }, { passive: false });

    // Touch drag
    let touchStartX = 0;
    let touchStartY = 0;
    let touchStartPanX = 0.5;
    let touchStartPanY = 0.5;
    let initialPinchDist = 0;
    let pinchStartZoom = 1;

    canvas.addEventListener('touchstart', (e) => {
      if (!photoUploaded[panelId]) return;
      if (e.touches.length === 1) {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
        const crop = PreviewRenderer.getPhotoCrop(panelId);
        touchStartPanX = crop.panX;
        touchStartPanY = crop.panY;
      } else if (e.touches.length === 2) {
        initialPinchDist = Math.hypot(
          e.touches[1].clientX - e.touches[0].clientX,
          e.touches[1].clientY - e.touches[0].clientY
        );
        pinchStartZoom = PreviewRenderer.getPhotoCrop(panelId).zoom;
      }
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (!photoUploaded[panelId]) return;
      const crop = PreviewRenderer.getPhotoCrop(panelId);
      if (e.touches.length === 1) {
        const dx = e.touches[0].clientX - touchStartX;
        const dy = e.touches[0].clientY - touchStartY;
        const rect = canvas.getBoundingClientRect();
        const sensitivity = 1.5 / crop.zoom;
        PreviewRenderer.setPhotoCrop(
          panelId,
          crop.zoom,
          touchStartPanX - (dx / rect.width) * sensitivity,
          touchStartPanY - (dy / rect.height) * sensitivity
        );
      } else if (e.touches.length === 2) {
        const dist = Math.hypot(
          e.touches[1].clientX - e.touches[0].clientX,
          e.touches[1].clientY - e.touches[0].clientY
        );
        const scale = dist / initialPinchDist;
        PreviewRenderer.setPhotoCrop(panelId, pinchStartZoom * scale, crop.panX, crop.panY);
      }
      e.preventDefault();
    }, { passive: false });

    canvas.addEventListener('touchend', () => {
      saveState();
    });

    canvas.style.cursor = 'grab';
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
    updatePanelToggle(wrap);
  }

  function updatePanelToggle(wrap) {
    if (!wrap) wrap = document.getElementById('panel-toggle-wrap');
    if (!wrap) return;

    if (thirdPanelEnabled) {
      wrap.innerHTML = `<button class="add-panel-btn" id="remove-panel-btn"><span class="icon">&minus;</span> Remove second photo</button>`;
      wrap.querySelector('#remove-panel-btn').addEventListener('click', () => {
        removeThirdPanel();
      });
    } else {
      wrap.innerHTML = `<button class="add-panel-btn" id="add-panel-btn"><span class="icon">+</span> Add second photo</button>`;
      wrap.querySelector('#add-panel-btn').addEventListener('click', () => {
        addThirdPanel();
      });
    }
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
        <div class="layout-option layout-option-grid${isActive}" data-layout="${key}" style="${layoutIconGridStyle(def)}">
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
    const areas = def.areas.map(r => '"' + r.join(' ') + '"').join(' ');
    return `grid-template-columns:${cols};grid-template-rows:${rows};grid-template-areas:${areas};`;
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

    return group;
  }

  // ── Poem Section ────────────────────────────────────────────

  function createPoemSection() {
    const section = document.createElement('div');
    section.className = 'form-section poem-climax';
    section.id = 'poem-section';

    const sectionTitle = (template.formLabels && template.formLabels.poemSectionTitle) || 'Now let\'s write their tribute poem';
    const libraryLink = (template.formLabels && template.formLabels.poemLibraryLink) || 'Or choose from our poem library instead';
    const label = poemLabel();

    section.innerHTML = `
      <h2 class="form-section-title">${sectionTitle}</h2>
      <button class="poem-generate-btn" id="generate-poem-btn">
        Create Their ${label}
      </button>
      <div id="poem-result" class="poem-result" style="display:none">
        <div class="poem-version-tabs" id="poem-version-tabs" style="display:none"></div>
        <div class="poem-result-text" id="poem-result-text"></div>
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

    const label = poemLabel();
    const nfId = nameFieldId();

    function updateGenerateButtonLabel() {
      const fields = PreviewRenderer.getFields();
      const name = fields[nfId];
      generateBtn.textContent = name
        ? `Create ${name}'s ${label}`
        : `Create Their ${label}`;
    }

    const nameInput = document.getElementById(`field-${nfId}`);
    if (nameInput) {
      nameInput.addEventListener('input', updateGenerateButtonLabel);
    }

    let loadingEl = null;

    function showPoemLoading(name) {
      if (!loadingEl) {
        loadingEl = document.createElement('div');
        loadingEl.className = 'poem-generating';
        loadingEl.innerHTML = `
          <div class="poem-generating-text">Writing ${name ? name + "'s" : 'their'} ${label.toLowerCase()}...</div>
          <div class="poem-generating-dots"><span></span><span></span><span></span></div>
        `;
      } else {
        loadingEl.querySelector('.poem-generating-text').textContent =
          `Writing ${name ? name + "'s" : 'their'} ${label.toLowerCase()}...`;
      }
      generateBtn.style.display = 'none';
      resultDiv.style.display = 'none';
      editArea.style.display = 'none';
      const section = document.getElementById('poem-section');
      const existing = section.querySelector('.poem-generating');
      if (!existing) section.insertBefore(loadingEl, resultDiv);
    }

    function hidePoemLoading() {
      if (loadingEl && loadingEl.parentNode) {
        loadingEl.parentNode.removeChild(loadingEl);
      }
    }

    function revealPoem(poemText) {
      resultText.innerHTML = '';
      const lines = poemText.split('\n');
      const LINE_DELAY = 250;

      lines.forEach((line, i) => {
        const span = document.createElement('span');
        span.className = 'poem-line';
        span.textContent = line || '\u00A0';
        span.style.animationDelay = `${i * LINE_DELAY}ms`;
        resultText.appendChild(span);
      });

      PreviewRenderer.setField('poemText', poemText);
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
        poemHistory.push(data.poem);
        activePoemIndex = poemHistory.length - 1;
        resultDiv.style.display = '';
        editArea.style.display = 'none';
        libraryArea.style.display = 'none';

        regenerationCount++;
        updateRegenCount();
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
      if (regenerationCount >= MAX_REGENERATIONS) return;
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
          regenBtn.disabled = regenerationCount >= MAX_REGENERATIONS;
          alert(data.error || 'Something went wrong. Please try again.');
          return;
        }

        revealPoem(data.poem);
        poemHistory.push(data.poem);
        activePoemIndex = poemHistory.length - 1;
        regenerationCount++;
        updateRegenCount();
        updateVersionTabs();
        saveState();
      } catch (err) {
        console.error('Regeneration failed:', err);
      }

      regenBtn.textContent = 'Try another version';
      regenBtn.disabled = regenerationCount >= MAX_REGENERATIONS;
    });

    function updateRegenCount() {
      const remaining = MAX_REGENERATIONS - regenerationCount;
      if (remaining <= 0) {
        regenCount.textContent = `No more regenerations \u2013 you can still edit the ${label.toLowerCase()}`;
        regenBtn.disabled = true;
      } else {
        regenCount.textContent = `${remaining} regeneration${remaining === 1 ? '' : 's'} remaining`;
      }
    }

    editBtn.addEventListener('click', () => {
      editTextarea.value = resultText.textContent;
      resultDiv.style.display = 'none';
      editArea.style.display = '';
    });

    saveEditBtn.addEventListener('click', () => {
      const edited = editTextarea.value.trim();
      if (edited) {
        resultText.textContent = edited;
        PreviewRenderer.setField('poemText', edited);
        if (activePoemIndex >= 0 && activePoemIndex < poemHistory.length) {
          poemHistory[activePoemIndex] = edited;
        }
        saveState();
      }
      editArea.style.display = 'none';
      resultDiv.style.display = '';
    });

    cancelEditBtn.addEventListener('click', () => {
      editArea.style.display = 'none';
      resultDiv.style.display = '';
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
        libraryPreview.textContent = `Select a ${label.toLowerCase()} to see a preview`;
        return;
      }

      try {
        const res = await fetch(`/api/poems/${librarySelect.value}`);
        const poem = await res.json();
        libraryPreview.textContent = poem.text;

        resultText.textContent = poem.text;
        resultDiv.style.display = '';
        editArea.style.display = 'none';
        generateBtn.style.display = 'none';

        PreviewRenderer.setField('poemText', poem.text);
        saveState();
      } catch (err) {
        libraryPreview.textContent = `Failed to load ${label.toLowerCase()}`;
      }
    });
  }

  // ── Size / Product Selector ─────────────────────────────────

  function createSizeSection() {
    const section = document.createElement('div');
    section.className = 'form-section';
    section.innerHTML = '<h2 class="form-section-title">Choose your size</h2>';

    const grid = document.createElement('div');
    grid.className = 'product-grid';

    for (const product of template.printProducts) {
      const option = document.createElement('div');
      option.className = `product-option${product.default ? ' selected' : ''}`;
      option.dataset.sku = product.sku;
      option.dataset.price = product.price;
      option.innerHTML = `
        <div>
          <span class="product-option-label">${product.label}</span>
          ${product.badge ? `<span class="product-option-badge">${product.badge}</span>` : ''}
        </div>
        <span class="product-option-price">$${(product.price / 100).toFixed(2)}</span>
      `;

      option.addEventListener('click', () => {
        grid.querySelectorAll('.product-option').forEach(o => o.classList.remove('selected'));
        option.classList.add('selected');
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

  // ── Order Type Label Updates ─────────────────────────────────

  function updateFormLabelsForOrderType() {
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

    const giftNote = document.getElementById('gift-detail-note');
    if (giftNote) giftNote.style.display = orderType === 'gift' ? '' : 'none';

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

  // ── Style Variant Selector ───────────────────────────────────

  function buildStyleSelector() {
    const container = document.getElementById('style-selector');
    if (!container || !template.styleVariants) return;

    const variants = [
      { key: 'classic-dark', label: 'Classic', thumbClass: 'style-thumb-dark' },
      { key: 'warm-natural', label: 'Warm', thumbClass: 'style-thumb-warm' },
      { key: 'soft-light', label: 'Light', thumbClass: 'style-thumb-light' }
    ];

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

  function updatePurchaseButton() {
    const btn = document.getElementById('purchase-btn');
    if (!btn) return;
    const product = getSelectedProduct();
    if (product) {
      btn.textContent = `Purchase \u2013 $${(product.price / 100).toFixed(2)}`;
    }
  }

  async function handlePurchase() {
    const btn = document.getElementById('purchase-btn');
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

    // Disable button and show loading
    btn.disabled = true;
    btn.textContent = 'Preparing checkout...';

    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: TEMPLATE_ID,
          sku: product.sku,
          fields,
          poemText: poemText.trim(),
          style: currentStyle,
          layout: currentLayout,
          orderType,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || 'Something went wrong. Please try again.');
        btn.disabled = false;
        updatePurchaseButton();
        return;
      }

      // Redirect to Stripe Checkout
      window.location.href = data.checkoutUrl;
    } catch (err) {
      console.error('Checkout error:', err);
      alert('Could not connect to checkout. Please try again.');
      btn.disabled = false;
      updatePurchaseButton();
    }
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
        poemHistory,
        activePoemIndex,
        photoCrop: PreviewRenderer.getPhotoCrop('photo'),
        panel2Crop: PreviewRenderer.getPhotoCrop('panel2'),
        thirdPanelEnabled,
        thirdPanelType,
        customRatios: PreviewRenderer.getCustomRatios(),
        selectedProduct: document.querySelector('.product-option.selected .product-option-label')?.textContent,
        selectedSku: document.querySelector('.product-option.selected')?.dataset?.sku,
        regenerationCount,
        timestamp: Date.now()
      };
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch (e) {
      // sessionStorage may not be available
    }
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

        // Restore poem
        if (state.fields.poemText) {
          PreviewRenderer.setField('poemText', state.fields.poemText);
          const resultDiv = document.getElementById('poem-result');
          const resultText = document.getElementById('poem-result-text');
          const generateBtn = document.getElementById('generate-poem-btn');
          if (resultDiv && resultText) {
            resultText.textContent = state.fields.poemText;
            resultDiv.style.display = '';
            generateBtn.style.display = 'none';
          }
        }

        // Restore poem history
        if (state.poemHistory && state.poemHistory.length > 0) {
          poemHistory = state.poemHistory;
          activePoemIndex = typeof state.activePoemIndex === 'number' && state.activePoemIndex >= 0
            ? state.activePoemIndex
            : poemHistory.length - 1;
          setTimeout(() => updateVersionTabs(), 50);
        }
      }

      // Restore custom ratios
      if (state.customRatios) {
        for (const [key, ratios] of Object.entries(state.customRatios)) {
          PreviewRenderer.setCustomRatios(key, ratios.columns, ratios.rows);
        }
      }

      // Restore third panel state
      if (state.thirdPanelEnabled) {
        thirdPanelEnabled = true;
        thirdPanelType = state.thirdPanelType || 'photo';
      }

      // Restore layout
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

      // Restore style
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
        updateFormLabelsForOrderType();
      }

      // Restore regen count
      if (state.regenerationCount) {
        regenerationCount = state.regenerationCount;
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

  // ── Start ──────────────────────────────────────────────────

  init();

})();
