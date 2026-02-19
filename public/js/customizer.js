/**
 * Customizer.js — Guided emotional flow for the ONE pet tribute product.
 * No template selection — goes straight to the 12-question guided experience.
 */

(function () {
  'use strict';

  const formPane = document.getElementById('form-pane');
  if (!formPane) return;

  const TEMPLATE_ID = 'pet-tribute';
  const SESSION_KEY = 'sbm-customizer-state';
  const MAX_REGENERATIONS = 3;

  let template = null;
  let poems = [];
  let regenerationCount = 0;
  let currentStyle = 'classic-dark';
  let currentLayout = 'side-by-side';

  // ── Initialization ─────────────────────────────────────────

  async function init() {
    try {
      const [tmplRes, poemsRes] = await Promise.all([
        fetch(`/api/templates/${TEMPLATE_ID}`),
        fetch('/api/poems')
      ]);

      if (!tmplRes.ok) {
        formPane.innerHTML = '<p style="padding:2rem;color:var(--color-error)">Could not load. <a href="/">Go back</a></p>';
        return;
      }

      template = await tmplRes.json();
      poems = await poemsRes.json();

      // Initialize preview renderer with both canvases
      PreviewRenderer.init('photo-canvas', 'tribute-canvas', template);

      // Build the guided form
      buildGuidedForm();

      // Build layout & style selectors
      buildLayoutSelector();
      buildStyleSelector();

      // Restore saved state
      restoreState();

    } catch (err) {
      console.error('Failed to load:', err);
      formPane.innerHTML = '<p style="padding:2rem;color:var(--color-error)">Something went wrong. <a href="/">Go back</a></p>';
    }
  }

  // ── Guided Form Builder ──────────────────────────────────────

  function buildGuidedForm() {
    formPane.innerHTML = '';

    // Intro
    const intro = document.createElement('div');
    intro.className = 'form-intro';
    intro.innerHTML = 'Getting to know your pet<span>Each detail helps us write their tribute</span>';
    formPane.appendChild(intro);

    // 1. Photo upload
    const photoSection = createSection('Share their photo');
    const slot = template.photoSlots[0];
    photoSection.appendChild(createUploadZone(slot));
    formPane.appendChild(photoSection);

    // 2–11. Memory fields (everything except poem-selector)
    const memSection = createSection('Tell us about them');
    for (const field of template.memoryFields) {
      if (field.type === 'poem-selector') continue;
      memSection.appendChild(createField(field));
    }
    formPane.appendChild(memSection);

    // 12. Poem generation — the climax
    formPane.appendChild(createPoemSection());

    // Size selector (revealed after poem)
    formPane.appendChild(createSizeSection());

    // Cart action
    const cartSection = document.createElement('div');
    cartSection.className = 'cart-action';
    cartSection.id = 'cart-section';
    cartSection.innerHTML = `
      <button class="btn btn-warm btn-lg" disabled title="Coming soon">
        Add to Cart
      </button>
      <p style="text-align:center;margin-top:0.5rem;font-size:0.85rem;color:var(--color-muted)">
        Checkout coming soon — your tribute is saved in this session
      </p>
    `;
    formPane.appendChild(cartSection);
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
    const localUrl = URL.createObjectURL(file);
    PreviewRenderer.setPhoto(localUrl, '50% 50%');

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
        PreviewRenderer.setPhoto(data.thumbnailUrl, data.crop.position);
        showUploadPreview(slotId, data.thumbnailUrl, wrapper, null, data.quality);
        saveState();
      } else {
        showUploadPreview(slotId, localUrl, wrapper, data.error || 'Upload failed');
      }
    } catch (err) {
      console.error('Upload error:', err);
      showUploadPreview(slotId, localUrl, wrapper, 'Upload failed — using local preview');
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
    if (quality && (quality.tier === 'usable' || quality.tier === 'low')) {
      const msg = document.createElement('p');
      msg.className = 'quality-message';
      msg.textContent = quality.message;
      wrapper.appendChild(msg);
    }
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

  // ── Poem Section — The Climax ────────────────────────────────

  function createPoemSection() {
    const section = document.createElement('div');
    section.className = 'form-section poem-climax';
    section.id = 'poem-section';

    section.innerHTML = `
      <h2 class="form-section-title">Now let's write their tribute poem</h2>
      <button class="poem-generate-btn" id="generate-poem-btn">
        Create Their Poem
      </button>
      <div id="poem-result" class="poem-result" style="display:none">
        <div class="poem-result-text" id="poem-result-text"></div>
        <div class="poem-actions">
          <button class="poem-regenerate-btn" id="poem-regenerate-btn">Try another version</button>
          <button class="poem-edit-btn" id="poem-edit-btn">Edit poem</button>
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
        <button class="poem-library-link" id="poem-library-toggle">Or choose from our poem library instead</button>
      </div>
      <div id="poem-library-area" style="display:none" class="poem-library-panel">
        <select id="poem-library-select">
          <option value="">Choose a poem...</option>
        </select>
        <div class="poem-library-preview" id="poem-library-preview">Select a poem to see a preview</div>
      </div>
    `;

    // Wire up events after inserting
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

    // Update generate button with pet name
    function updateGenerateButtonLabel() {
      const fields = PreviewRenderer.getFields();
      const name = fields.petName;
      generateBtn.textContent = name
        ? `Create ${name}'s Poem`
        : 'Create Their Poem';
    }

    // Observe name field changes
    const nameInput = document.getElementById('field-petName');
    if (nameInput) {
      nameInput.addEventListener('input', updateGenerateButtonLabel);
    }

    // Loading indicator element (created on demand)
    let loadingEl = null;

    function showPoemLoading(petName) {
      if (!loadingEl) {
        loadingEl = document.createElement('div');
        loadingEl.className = 'poem-generating';
        loadingEl.innerHTML = `
          <div class="poem-generating-text">Writing ${petName ? petName + "'s" : 'their'} poem...</div>
          <div class="poem-generating-dots"><span></span><span></span><span></span></div>
        `;
      } else {
        loadingEl.querySelector('.poem-generating-text').textContent =
          `Writing ${petName ? petName + "'s" : 'their'} poem...`;
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

    /**
     * Animate poem text line by line into the result element.
     * Each line fades in with a stagger delay — "let the moment land."
     */
    function revealPoem(poemText) {
      resultText.innerHTML = '';
      const lines = poemText.split('\n');
      const LINE_DELAY = 250; // ms between each line

      lines.forEach((line, i) => {
        const span = document.createElement('span');
        span.className = 'poem-line';
        span.textContent = line || '\u00A0'; // non-breaking space for blank lines
        span.style.animationDelay = `${i * LINE_DELAY}ms`;
        resultText.appendChild(span);
      });

      // Update preview immediately (the canvas doesn't need animation)
      PreviewRenderer.setField('poemText', poemText);
    }

    // Build the body for poem generation requests
    function buildPoemBody() {
      const fields = PreviewRenderer.getFields();
      return {
        petName: fields.petName || '',
        petType: fields.petType || '',
        breed: fields.breed || '',
        nicknames: fields.petNicknames || '',
        personality: fields.personality || '',
        favoriteMemory: fields.favoriteMemory || '',
        favoriteThing: fields.favoriteThing || ''
      };
    }

    // Generate poem
    async function generatePoem() {
      const fields = PreviewRenderer.getFields();
      generateBtn.disabled = true;
      showPoemLoading(fields.petName);

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
        resultDiv.style.display = '';
        editArea.style.display = 'none';
        libraryArea.style.display = 'none';

        regenerationCount++;
        updateRegenCount();
        saveState();

        generateBtn.style.display = 'none';
      } catch (err) {
        console.error('Poem generation failed:', err);
        hidePoemLoading();
        updateGenerateButtonLabel();
        generateBtn.style.display = '';
      }

      generateBtn.disabled = false;
    }

    generateBtn.addEventListener('click', generatePoem);

    // Regenerate
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
        regenerationCount++;
        updateRegenCount();
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
        regenCount.textContent = 'No more regenerations — you can still edit the poem';
        regenBtn.disabled = true;
      } else {
        regenCount.textContent = `${remaining} regeneration${remaining === 1 ? '' : 's'} remaining`;
      }
    }

    // Edit poem
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
        saveState();
      }
      editArea.style.display = 'none';
      resultDiv.style.display = '';
    });

    cancelEditBtn.addEventListener('click', () => {
      editArea.style.display = 'none';
      resultDiv.style.display = '';
    });

    // Library toggle
    libraryToggle.addEventListener('click', () => {
      const showing = libraryArea.style.display !== 'none';
      libraryArea.style.display = showing ? 'none' : '';

      if (!showing && librarySelect.options.length <= 1) {
        // Populate library
        for (const p of poems) {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = `${p.title}${p.author ? ` — ${p.author}` : ''}`;
          librarySelect.appendChild(opt);
        }
      }
    });

    librarySelect.addEventListener('change', async () => {
      if (!librarySelect.value) {
        libraryPreview.textContent = 'Select a poem to see a preview';
        return;
      }

      try {
        const res = await fetch(`/api/poems/${librarySelect.value}`);
        const poem = await res.json();
        libraryPreview.textContent = poem.text;

        // Apply to preview
        resultText.textContent = poem.text;
        resultDiv.style.display = '';
        editArea.style.display = 'none';
        generateBtn.style.display = 'none';

        PreviewRenderer.setField('poemText', poem.text);
        saveState();
      } catch (err) {
        libraryPreview.textContent = 'Failed to load poem';
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
        saveState();
      });

      grid.appendChild(option);
    }

    section.appendChild(grid);
    return section;
  }

  // ── Layout Selector ──────────────────────────────────────────

  function buildLayoutSelector() {
    const container = document.getElementById('layout-selector');
    if (!container) return;

    container.querySelectorAll('.layout-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const layout = opt.dataset.layout;
        currentLayout = layout;
        PreviewRenderer.setLayout(layout);

        container.querySelectorAll('.layout-option').forEach(o => o.classList.remove('active'));
        opt.classList.add('active');
        saveState();
      });
    });
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

    // Update CSS frame theme
    const frameEl = document.getElementById('frame-preview');
    if (frameEl) {
      frameEl.className = 'frame-preview theme-' + styleKey;
    }

    // Update preview renderer colors
    if (template.styleVariants[styleKey]) {
      PreviewRenderer.setStyle(template.styleVariants[styleKey]);
    }

    saveState();
  }

  // ── State Persistence ──────────────────────────────────────

  function saveState() {
    try {
      const state = {
        templateId: TEMPLATE_ID,
        fields: PreviewRenderer.getFields(),
        style: currentStyle,
        layout: currentLayout,
        selectedProduct: document.querySelector('.product-option.selected .product-option-label')?.textContent,
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
          if (fieldId === 'poemText') continue; // handle separately
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
      }

      // Restore style
      if (state.style && state.style !== currentStyle) {
        setStyle(state.style);
        const thumbs = document.querySelectorAll('.style-thumb');
        thumbs.forEach(t => {
          t.classList.toggle('active', t.dataset.style === state.style);
        });
      }

      // Restore layout
      if (state.layout && state.layout !== currentLayout) {
        currentLayout = state.layout;
        PreviewRenderer.setLayout(state.layout);
        const layoutOpts = document.querySelectorAll('.layout-option');
        layoutOpts.forEach(o => {
          o.classList.toggle('active', o.dataset.layout === state.layout);
        });
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
    } catch (e) {
      // Ignore restore errors
    }
  }

  // ── Start ──────────────────────────────────────────────────

  init();

})();
