/**
 * Preview.js – Dynamic multi-panel tribute renderer.
 *
 * Manages an arbitrary number of panels (photo, tribute, text) laid out
 * via CSS Grid.  The host container (#preview-panels) receives inline
 * grid-template-columns / rows / areas plus aspect-ratio from a LAYOUTS
 * table.  Each panel owns a <canvas> that is sized to its grid cell.
 *
 * Photo panel: Pet photo with cover-fit and smart crop positioning.
 * Tribute panel: Name, dates, divider, poem, nickname, family attribution.
 * Text panel: User-entered custom message text.
 *
 * Design principle: the poem is the product. When space is tight we
 * compress margins and spacing first, then shrink the poem font as a last
 * resort. Fit is guaranteed — the tribute is never clipped — so in a short
 * portrait panel the poem shrinks to a legible floor rather than spilling
 * past the footer. Lines are balanced (no lone orphan word) via wrapText.
 */

(function () {
  'use strict';

  // ── Client Color Math ──────────────────────────────────────
  // Mirror of src/services/colorUtils.js — keep the two in sync.

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex(rgb) {
    const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + c(rgb.r) + c(rgb.g) + c(rgb.b);
  }

  function hexToHsl(hex) {
    let { r, g, b } = hexToRgb(hex);
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    return { h, s, l };
  }

  function hslToHex(hsl) {
    const { h, s, l } = hsl;
    if (s === 0) {
      const v = l * 255;
      return rgbToHex({ r: v, g: v, b: v });
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue = t => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return rgbToHex({ r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255 });
  }

  function mixHex(hexA, hexB, amount) {
    const a = hexToRgb(hexA), b = hexToRgb(hexB);
    return rgbToHex({
      r: a.r + (b.r - a.r) * amount,
      g: a.g + (b.g - a.g) * amount,
      b: a.b + (b.b - a.b) * amount
    });
  }

  function luminance(hex) {
    const { r, g, b } = hexToRgb(hex);
    const lin = v => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  function contrast(hexA, hexB) {
    const la = luminance(hexA), lb = luminance(hexB);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  }

  window.ColorMath = { hexToRgb, rgbToHex, hexToHsl, hslToHex, mix: mixHex, luminance, contrast };

  // ── Layout Definitions ────────────────────────────────────
  //
  // Each layout specifies CSS Grid tracks and named areas.
  // `columns` / `rows` are arrays of fr values.
  // `areas` is a 2-D array of grid-area names (row-major).

  const LAYOUTS = {
    // 2-panel
    'side-by-side': {
      label: 'Landscape',
      panels: 2,
      columns: [1, 1],
      rows: [1],
      areas: [['photo', 'tribute']],
      aspectRatio: '5/3.2'
    },
    'stacked': {
      label: 'Portrait',
      panels: 2,
      columns: [1],
      rows: [1, 1],
      areas: [['photo'], ['tribute']],
      aspectRatio: '4/5'
    },
    // 3-panel
    'hero-left': {
      label: 'Feature Left',
      panels: 3,
      columns: [1.15, 1],
      rows: [1, 1],
      areas: [['photo', 'panel2'], ['photo', 'tribute']],
      aspectRatio: '5/3.8'
    },
    'hero-top': {
      label: 'Feature Top',
      panels: 3,
      columns: [1, 1],
      rows: [1.3, 1],
      areas: [['photo', 'photo'], ['panel2', 'tribute']],
      aspectRatio: '4/5'
    },
    'photos-left': {
      label: 'Gallery Left',
      panels: 3,
      columns: [1, 1.15],
      rows: [1, 1],
      areas: [['photo', 'tribute'], ['panel2', 'tribute']],
      aspectRatio: '5/3.8'
    },
    'tribute-top': {
      label: 'Poem First',
      panels: 3,
      columns: [1, 1],
      rows: [1, 1.3],
      areas: [['tribute', 'tribute'], ['photo', 'panel2']],
      aspectRatio: '4/5'
    }
  };

  // ── State ──────────────────────────────────────────────────

  let container = null;       // #preview-panels DOM element
  let template = null;
  let activeLayouts = LAYOUTS; // LAYOUTS filtered to what the template declares
  let currentLayout = 'side-by-side';

  // panels Map: areaName -> { canvas, ctx, type, panelEl }
  const panels = new Map();

  // photos object: panelId -> { image, position, zoom, panX, panY }
  const photos = {};

  // Frame size from selected product SKU (e.g. [11, 14] for "framed-11x14")
  let frameDims = null;

  // Chosen frame definition { id, faceIn, molding, swatch } from template.frameOptions
  let currentFrame = null;

  // Poem position: false = poem after photo (right/below), true = before (left/above)
  let poemFirst = false;

  // Custom fr ratios (user-dragged dividers): layoutKey -> { columns: [...], rows: [...] }
  const customRatios = {};

  let fields = {};           // fieldId → value
  let styleColors = null;    // current style variant colors
  let nameOnFrame = false;   // true when name/dates are engraved on the frame (auto theme)
  let frameIcon = 'paw';     // engraved symbol beside the name: 'none' | 'paw' | 'heart'
  let previewPoemText = '';  // sample poem shown before a real one is generated (display only)
  let previewName = '';      // sample name shown before one is entered (display only)
  let previewDates = '';     // sample dates shown before entered (display only)
  let fontsLoaded = false;
  let renderQueued = false;

  // Elegant single-color engraved symbols (inherit the accent color)
  const FRAME_ICONS = {
    none: '',
    paw: '<svg viewBox="0 0 64 64" aria-hidden="true"><ellipse cx="14" cy="29" rx="5.4" ry="7.6"/><ellipse cx="25" cy="20" rx="5.6" ry="8.4"/><ellipse cx="39" cy="20" rx="5.6" ry="8.4"/><ellipse cx="50" cy="29" rx="5.4" ry="7.6"/><path d="M32 33c-9 0-15 6.6-15 13.4 0 6.5 6.4 8.6 15 8.6s15-2.1 15-8.6C47 39.6 41 33 32 33z"/></svg>',
    heart: '<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M32 55C13 41 6 30 6 20.5 6 12.5 12 7 19 7c5.6 0 10.4 3.6 13 8 2.6-4.4 7.4-8 13-8 7 0 13 5.5 13 13.5C58 30 51 41 32 55z"/></svg>'
  };

  // ── Public API ─────────────────────────────────────────────

  window.PreviewRenderer = {
    init,
    setPhoto,
    setPhotoCrop,
    getPhotoCrop,
    getPhotoCanvas,
    setField,
    setStyle,
    setColors,
    setFrameIcon,
    getFrameIcon: () => frameIcon,
    setPreviewPoem,
    setPreviewHeader,
    setFrame,
    setPoemPosition,
    getPoemPosition: () => poemFirst,
    setLayout,
    setFrameSize,
    getFields: () => ({ ...fields }),
    render,
    getCurrentFrValues,
    setCustomRatios,
    resetCustomRatios,
    getCustomRatios: () => JSON.parse(JSON.stringify(customRatios)),
    getPanels: () => panels,
    swapPhotos,
    getLayouts: () => activeLayouts,
    getCurrentLayout: () => currentLayout,
    getContainer: () => container
  };

  // ── Initialization ─────────────────────────────────────────

  function init(containerId, tmpl) {
    container = document.getElementById(containerId);
    if (!container) return;

    template = tmpl;

    // Only expose layouts the template actually declares
    if (tmpl && tmpl.layouts) {
      activeLayouts = {};
      for (const key of Object.keys(LAYOUTS)) {
        if (tmpl.layouts[key]) activeLayouts[key] = LAYOUTS[key];
      }
    } else {
      activeLayouts = LAYOUTS;
    }
    if (!activeLayouts[currentLayout]) {
      currentLayout = (tmpl && tmpl.defaultLayout) || Object.keys(activeLayouts)[0];
    }

    // Set default style colors
    if (tmpl && tmpl.styleVariants && tmpl.defaultStyle) {
      styleColors = tmpl.styleVariants[tmpl.defaultStyle];
    }

    // Apply default field values
    if (tmpl && tmpl.memoryFields) {
      for (const mf of tmpl.memoryFields) {
        if (mf.default) fields[mf.id] = mf.default;
      }
    }

    // Build initial panels
    buildPanels(currentLayout);

    loadFonts().then(() => {
      fontsLoaded = true;
      sizeCanvases();
      queueRender();
    });

    window.addEventListener('resize', () => {
      sizeCanvases();
      queueRender();
    });
  }

  async function loadFonts() {
    const families = ['Cormorant Garamond', 'Source Sans 3', 'Playfair Display'];
    const weights = ['300', '400', '500', '600', '700'];
    try {
      const loads = [];
      for (const f of families) {
        for (const w of weights) {
          loads.push(document.fonts.load(`${w} 48px "${f}"`));
        }
      }
      loads.push(document.fonts.load('italic 300 48px "Cormorant Garamond"'));
      loads.push(document.fonts.load('italic 400 48px "Cormorant Garamond"'));
      await Promise.all(loads);
    } catch (e) {
      // Some weights may not exist
    }
  }

  // ── Panel Building ─────────────────────────────────────────

  function buildPanels(layoutKey) {
    const layout = activeLayouts[layoutKey];
    if (!layout) return;

    currentLayout = layoutKey;

    // Determine which area names this layout uses
    const areaNames = new Set();
    for (const row of layout.areas) {
      for (const name of row) {
        areaNames.add(name);
      }
    }

    // Remove panels that aren't in this layout
    for (const [name, panel] of panels) {
      if (!areaNames.has(name)) {
        panel.panelEl.remove();
        panels.delete(name);
      }
    }

    // Create panels that don't exist yet
    for (const name of areaNames) {
      if (!panels.has(name)) {
        const type = panelTypeForArea(name);
        const panelEl = document.createElement('div');
        panelEl.className = `panel panel-${name}`;
        panelEl.id = `panel-${name}`;

        const canvas = document.createElement('canvas');
        canvas.id = `canvas-${name}`;
        panelEl.appendChild(canvas);

        container.appendChild(panelEl);
        const ctx = canvas.getContext('2d');
        panels.set(name, { canvas, ctx, type, panelEl });
      }
    }

    // Apply CSS Grid inline styles
    applyGridStyles(layoutKey);
  }

  function panelTypeForArea(areaName) {
    if (areaName === 'tribute') return 'tribute';
    if (areaName === 'photo') return 'photo';
    // panel2 defaults to photo but can be text
    return 'photo';
  }

  function applyGridStyles(layoutKey) {
    const layout = activeLayouts[layoutKey];
    if (!layout || !container) return;

    const ratios = customRatios[layoutKey];
    const cols = ratios ? ratios.columns : layout.columns;
    const rows = ratios ? ratios.rows : layout.rows;

    container.style.gridTemplateColumns = cols.map(v => v + 'fr').join(' ');
    container.style.gridTemplateRows = rows.map(v => v + 'fr').join(' ');
    // Poem position: when poemFirst, swap the photo and tribute cells so the
    // poem sits left (landscape) or above (portrait) instead of right/below.
    var areasSrc = poemFirst
      ? layout.areas.map(function (row) {
          return row.map(function (cell) {
            return cell === 'photo' ? 'tribute' : (cell === 'tribute' ? 'photo' : cell);
          });
        })
      : layout.areas;
    container.style.gridTemplateAreas = areasSrc.map(
      row => '"' + row.join(' ') + '"'
    ).join(' ');

    // Use frame size if selected, otherwise fall back to layout default
    if (frameDims) {
      // Determine if this layout is landscape or portrait from its default ratio
      var parts = layout.aspectRatio.split('/');
      var isLandscape = parseFloat(parts[0]) > parseFloat(parts[1]);
      var w = isLandscape ? Math.max(frameDims[0], frameDims[1]) : Math.min(frameDims[0], frameDims[1]);
      var h = isLandscape ? Math.min(frameDims[0], frameDims[1]) : Math.max(frameDims[0], frameDims[1]);

      // Render the frame at true scale: the real frame face is FRAME_FACE_IN
      // wide, so its share of the preview width is face/(print + 2*face).
      // A fixed pixel width reads far too chunky on the larger print sizes.
      // The chosen frame's real face width drives this so a thin 0.875" black
      // and a 3.25" Vintage Copper look correctly different in the preview.
      var FRAME_FACE_IN = (currentFrame && currentFrame.faceIn) || 0.875;
      var frameRoot = document.getElementById('frame-preview');
      if (frameRoot) {
        var facePct = (FRAME_FACE_IN / (w + 2 * FRAME_FACE_IN)) * 100;
        frameRoot.style.setProperty('--frame-width', facePct.toFixed(2) + '%');
      }

      // Printed-mat templates: the panels region represents the openings
      // INSIDE the mat border, so subtract the border from each side.
      // The mat itself is rendered by .mat-board padding around this region.
      if (template && template.colorMode === 'auto' && template.printSpec) {
        var b = template.printSpec.matBorderIn * 2;
        if (w - b > 0 && h - b > 0) { w = w - b; h = h - b; }
      }
      container.style.aspectRatio = w + '/' + h;
    } else {
      container.style.aspectRatio = layout.aspectRatio;
    }
  }

  // ── Data Setters ───────────────────────────────────────────

  function setPhoto(panelIdOrUrl, urlOrPosition, maybePosition) {
    // Backward compat: setPhoto(url, position) maps to panelId 'photo'
    let panelId, imageUrl, position;
    if (maybePosition !== undefined) {
      panelId = panelIdOrUrl;
      imageUrl = urlOrPosition;
      position = maybePosition;
    } else {
      panelId = 'photo';
      imageUrl = panelIdOrUrl;
      position = urlOrPosition;
    }

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const existing = photos[panelId];
      photos[panelId] = {
        image: img,
        position: position || '50% 50%',
        zoom: existing ? existing.zoom : 1,
        panX: existing ? existing.panX : 0.5,
        panY: existing ? existing.panY : 0.5
      };
      queueRender();
    };
    img.src = imageUrl;
  }

  function setPhotoCrop(panelIdOrZoom, zoomOrPanX, panXOrPanY, maybePanY) {
    // Backward compat: setPhotoCrop(zoom, panX, panY) maps to panelId 'photo'
    let panelId, zoom, panX, panY;
    if (maybePanY !== undefined) {
      panelId = panelIdOrZoom;
      zoom = zoomOrPanX;
      panX = panXOrPanY;
      panY = maybePanY;
    } else {
      panelId = 'photo';
      zoom = panelIdOrZoom;
      panX = zoomOrPanX;
      panY = panXOrPanY;
    }

    if (!photos[panelId]) {
      photos[panelId] = { image: null, position: '50% 50%', zoom: 1, panX: 0.5, panY: 0.5 };
    }
    photos[panelId].zoom = Math.max(1, Math.min(3, zoom));
    photos[panelId].panX = Math.max(0, Math.min(1, panX));
    photos[panelId].panY = Math.max(0, Math.min(1, panY));
    queueRender();
  }

  function getPhotoCrop(panelId) {
    panelId = panelId || 'photo';
    const p = photos[panelId];
    if (!p) return { zoom: 1, panX: 0.5, panY: 0.5 };
    return { zoom: p.zoom || 1, panX: p.panX || 0.5, panY: p.panY || 0.5 };
  }

  function getPhotoCanvas(panelId) {
    panelId = panelId || 'photo';
    const panel = panels.get(panelId);
    return panel ? panel.canvas : null;
  }

  /**
   * Swap photos between the main photo panel and panel2.
   * Swaps both the image data and crop settings.
   */
  function swapPhotos() {
    const a = photos['photo'];
    const b = photos['panel2'];
    if (!a && !b) return;
    photos['photo'] = b || null;
    photos['panel2'] = a || null;
    queueRender();
  }

  function setField(fieldId, value) {
    fields[fieldId] = value;
    // When the name/dates are engraved on the frame (auto theme), keep that
    // HTML in sync as the user types — it lives outside the canvas.
    if (nameOnFrame && template && template.tributeMapping) {
      const tm = template.tributeMapping;
      if (fieldId === tm.name || fieldId === tm.birthDate || fieldId === tm.passDate) {
        updateFrameText();
      }
    }
    queueRender();
  }

  function setStyle(variant) {
    styleColors = variant;
    queueRender();
  }

  // ── Engraved name + dates on the 3D-printed frame ──────────────
  //
  // For colorMode:'auto' templates the frame is a 3D-printed object in the
  // pet's color, with the name engraved at the top and dates at the bottom.
  // Those two lines are HTML on the frame border (not canvas), so they can
  // carry the engraved text-shadow and update live as the user types.

  function ensureFrameTextEls() {
    const frameEl = document.getElementById('frame-preview');
    if (!frameEl) return null;
    const border = frameEl.querySelector('.frame-border');
    if (!border) return null;
    const matBoard = border.querySelector('.mat-board');
    let nameEl = border.querySelector('.frame-name');
    let datesEl = border.querySelector('.frame-dates');
    if (!nameEl) {
      nameEl = document.createElement('div');
      nameEl.className = 'frame-name';
      // Symbol sandwiches the name: [paw] Name [paw]
      nameEl.innerHTML =
        '<span class="frame-icon frame-icon-l"></span>' +
        '<span class="frame-name-text"></span>' +
        '<span class="frame-icon frame-icon-r"></span>';
      border.insertBefore(nameEl, matBoard);
    }
    if (!datesEl) {
      datesEl = document.createElement('div');
      datesEl.className = 'frame-dates';
      border.appendChild(datesEl);
    }
    return {
      nameEl,
      datesEl,
      iconL: nameEl.querySelector('.frame-icon-l'),
      iconR: nameEl.querySelector('.frame-icon-r'),
      nameTextEl: nameEl.querySelector('.frame-name-text')
    };
  }

  function updateFrameText() {
    const els = ensureFrameTextEls();
    if (!els) return;
    const tm = (template && template.tributeMapping) || {};
    const name = (fields[tm.name || 'petName'] || '').trim();
    const birth = (fields[tm.birthDate || 'birthDate'] || '').trim();
    const pass = (fields[tm.passDate || 'passDate'] || '').trim();
    let dateStr = '';
    if (birth && pass) dateStr = birth + ' – ' + pass;
    else if (birth) dateStr = birth;
    else if (pass) dateStr = pass;

    els.nameTextEl.textContent = name || 'Their name';
    els.nameEl.classList.toggle('placeholder', !name);
    const iconSvg = FRAME_ICONS[frameIcon] || '';
    els.iconL.innerHTML = iconSvg;
    els.iconR.innerHTML = iconSvg;

    if (dateStr) {
      els.datesEl.textContent = dateStr;
      els.datesEl.classList.remove('placeholder');
    } else {
      els.datesEl.textContent = 'Birth – Passing';
      els.datesEl.classList.add('placeholder');
    }
  }

  function setFrameIcon(name) {
    frameIcon = FRAME_ICONS[name] !== undefined ? name : 'none';
    if (nameOnFrame) updateFrameText();
  }

  // Remove any engraved name/dates elements so the frame stays clean.
  // (Text-on-frame is disabled — name/dates read in the tribute panel.)
  function removeFrameText() {
    const frameEl = document.getElementById('frame-preview');
    if (!frameEl) return;
    const border = frameEl.querySelector('.frame-border');
    if (!border) return;
    const nameEl = border.querySelector('.frame-name');
    const datesEl = border.querySelector('.frame-dates');
    if (nameEl) nameEl.remove();
    if (datesEl) datesEl.remove();
  }

  function setPreviewPoem(text) {
    previewPoemText = text || '';
    queueRender();
  }

  // Sample name/dates title shown (muted) before the customer enters their own,
  // so the tribute's header is visibly demonstrated in the empty state.
  function setPreviewHeader(name, dates) {
    previewName = name || '';
    previewDates = dates || '';
    queueRender();
  }

  // Poem position: true puts the poem before the photo (left in landscape,
  // above in portrait). Re-lays out and re-renders.
  function setPoemPosition(first) {
    poemFirst = !!first;
    applyGridStyles(currentLayout);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { sizeCanvases(); render(); });
    });
  }

  // Apply the customer's chosen frame — molding color live on the border and
  // real face width (via applyGridStyles) so the preview matches what ships.
  function setFrame(frameDef) {
    if (!frameDef) return;
    currentFrame = frameDef;
    const border = container && container.closest('.frame-preview')
      ? container.closest('.frame-preview').querySelector('.frame-border')
      : document.querySelector('#frame-preview .frame-border');
    if (border && frameDef.molding) border.style.background = frameDef.molding;
    // Recompute frame face width for the current size/layout.
    applyGridStyles(currentLayout);
    queueRender();
  }

  /**
   * Apply auto-matched colors { accent, bevel, ... } to the preview.
   *
   * The frame itself is always the elegant classic dark wood molding — no text
   * printed on it, no photo-matched frame color. The photo + poem sit on a
   * light paper insert, and the name/dates/nickname read as printed text in
   * the tribute panel (see the main render path). The auto-matched bevel/accent
   * still tints the divider so the color-matching carries into the print.
   */
  function setColors(c) {
    if (!c || (!c.frame && !c.mat)) return;
    // Name/dates live in the printed panel, never engraved on the frame.
    nameOnFrame = false;

    const accent = c.accent || c.bevel || '#C4A882';
    // Fixed elegant dark wood — the frame is not color-matched to the photo.
    const darkWood = '#1c1c1c';

    const frameEl = document.getElementById('frame-preview');
    if (frameEl) {
      frameEl.className = 'frame-preview theme-auto';
      frameEl.style.setProperty('--frame-color', darkWood);
      // Lighter/darker tones give the molding its gradient "light on the frame" look
      frameEl.style.setProperty('--frame-hi', mixHex(darkWood, '#ffffff', 0.14));
      frameEl.style.setProperty('--frame-lo', mixHex(darkWood, '#000000', 0.35));
      frameEl.style.setProperty('--accent-color', accent);
    }

    // Any frame text from a prior render is removed — the frame stays clean.
    removeFrameText();

    // The insert is photo-paper: light background, dark ink for the text.
    const ink = '#332C26';
    styleColors = {
      ...(styleColors || {}),
      tribute: {
        background: '#FAF7F2',
        name: ink,
        dates: ink,
        divider: accent,
        poem: ink,
        nickname: mixHex(ink, '#FAF7F2', 0.18),
        family: mixHex(ink, '#FAF7F2', 0.28)
      }
    };

    queueRender();
  }

  function setLayout(layoutKey) {
    if (!activeLayouts[layoutKey]) return;
    buildPanels(layoutKey);

    // Double rAF ensures CSS Grid reflow completes before measuring
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        sizeCanvases();
        render();
      });
    });
  }

  function setFrameSize(sku) {
    // Parse "framed-11x14" → [11, 14]
    var match = sku && sku.match(/framed-(\d+)x(\d+)/);
    if (!match) { frameDims = null; return; }
    frameDims = [parseInt(match[1], 10), parseInt(match[2], 10)];
    applyGridStyles(currentLayout);
    // Double rAF ensures browser has reflowed the CSS aspect-ratio
    // change before we measure panel dimensions and re-render text
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        sizeCanvases();
        render();
      });
    });
  }

  // ── Custom Ratio API (for divider drag) ────────────────────

  function getCurrentFrValues() {
    const layout = activeLayouts[currentLayout];
    if (!layout) return null;
    const ratios = customRatios[currentLayout];
    return {
      columns: ratios ? [...ratios.columns] : [...layout.columns],
      rows: ratios ? [...ratios.rows] : [...layout.rows]
    };
  }

  function setCustomRatios(layoutKey, cols, rows) {
    customRatios[layoutKey] = { columns: [...cols], rows: [...rows] };
    if (layoutKey === currentLayout) {
      applyGridStyles(currentLayout);
      requestAnimationFrame(() => {
        sizeCanvases();
        queueRender();
      });
    }
  }

  function resetCustomRatios(layoutKey) {
    delete customRatios[layoutKey || currentLayout];
    applyGridStyles(currentLayout);
    requestAnimationFrame(() => {
      sizeCanvases();
      queueRender();
    });
  }

  // ── Canvas Sizing ──────────────────────────────────────────

  function sizeCanvases() {
    const dpr = window.devicePixelRatio || 1;

    for (const [, panel] of panels) {
      const el = panel.panelEl;
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w === 0 || h === 0) continue;
      panel.canvas.width = Math.round(w * dpr);
      panel.canvas.height = Math.round(h * dpr);
      panel.canvas.style.width = w + 'px';
      panel.canvas.style.height = h + 'px';
    }
  }

  // ── Render Loop ────────────────────────────────────────────

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      render();
    });
  }

  function render() {
    for (const [name, panel] of panels) {
      switch (panel.type) {
        case 'photo':
          renderPhotoPanel(panel.ctx, panel.canvas, name);
          break;
        case 'tribute':
          renderTributePanel(panel.ctx, panel.canvas);
          break;
        case 'text':
          renderTextPanel(panel.ctx, panel.canvas, name);
          break;
      }
    }
  }

  // ── Photo Panel ────────────────────────────────────────────

  function renderPhotoPanel(ctx, canvas, panelId) {
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;

    const bg = styleColors?.tribute?.background || '#1a1a1a';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const photoData = photos[panelId];
    if (photoData && photoData.image) {
      drawCoverImage(ctx, photoData.image, photoData, 0, 0, w, h);
    } else {
      renderPhotoPlaceholder(ctx, w, h, panelId);
    }
  }

  function renderPhotoPlaceholder(ctx, w, h, panelId) {
    // Choose ink that's visible on whatever the insert/panel background is
    // (light paper for the auto theme, dark for the legacy themes).
    const bg = styleColors?.tribute?.background || '#1a1a1a';
    const lightBg = luminance(bg) > 0.5;
    const stroke = lightBg ? 'rgba(60,52,44,0.22)' : 'rgba(255,255,255,0.12)';
    const fillBg = lightBg ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.03)';
    const labelColor = lightBg ? 'rgba(60,52,44,0.4)' : 'rgba(255,255,255,0.15)';

    ctx.fillStyle = fillBg;
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const iconSize = Math.min(w, h) * 0.12;

    ctx.strokeStyle = stroke;
    ctx.lineWidth = iconSize * 0.06;

    ctx.beginPath();
    roundedRect(ctx, cx - iconSize, cy - iconSize * 0.7, iconSize * 2, iconSize * 1.4, iconSize * 0.15);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, iconSize * 0.4, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = labelColor;
    ctx.font = `400 ${Math.round(iconSize * 0.3)}px "Source Sans 3", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const label = panelId === 'photo' ? 'Upload their photo' : 'Upload second photo';
    ctx.fillText(label, cx, cy + iconSize * 1.1);
  }

  // ── Tribute Panel ──────────────────────────────────────────

  function renderTributePanel(ctx, canvas) {
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;

    const colors = {
      bg: styleColors?.tribute?.background || '#1a1a1a',
      name: styleColors?.tribute?.name || '#FAF8F5',
      dates: styleColors?.tribute?.dates || '#9B9590',
      divider: styleColors?.tribute?.divider || '#C4A882',
      poem: styleColors?.tribute?.poem || '#C4A882',
      nickname: styleColors?.tribute?.nickname || '#9B9590',
      family: styleColors?.tribute?.family || '#9B9590'
    };

    // Background
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);
    const grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, h * 0.6);
    grad.addColorStop(0, 'rgba(196, 168, 130, 0.04)');
    grad.addColorStop(1, 'rgba(196, 168, 130, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // Scale by the limiting dimension – width for tall/narrow panels,
    // height for wide/short panels (stacked layout). Prevents text from
    // blowing up when the panel is wide but short.
    const scale = Math.min(w / 400, h / 260);
    const cx = w / 2;
    const maxTextWidth = w * 0.76;

    // ── Content (read from tributeMapping or fall back to pet defaults) ──

    const tm = (template && template.tributeMapping) || {};
    const nameField = tm.name || 'petName';
    const nickField = tm.nickname || 'petNicknames';
    const famField = tm.familyName || 'familyName';
    const famPrefix = tm.familyPrefix || 'Beloved companion of';
    const birthField = tm.birthDate || 'birthDate';
    const passField = tm.passDate || 'passDate';
    const poemField = tm.poemText || 'poemText';

    // Name, dates, nickname and poem all read in the printed tribute panel.
    let petName = fields[nameField] || '';
    let headerIsSample = false;
    if (!petName && previewName) { petName = previewName; headerIsSample = true; }
    const nickname = fields[nickField] || '';
    const familyName = fields[famField] || '';
    let poemText = fields[poemField] || '';
    // Sample poem so the panel isn't empty before one is generated (display only \u2014
    // never the real poemText; checkout still requires a generated/selected poem).
    let poemIsSample = false;
    if (!poemText && previewPoemText) {
      poemText = previewPoemText;
      poemIsSample = true;
    }
    const birthDate = fields[birthField] || '';
    const passDate = fields[passField] || '';
    let dateStr = '';
    if (birthDate && passDate) dateStr = birthDate + ' \u2013 ' + passDate;
    else if (birthDate) dateStr = birthDate;
    else if (passDate) dateStr = passDate;
    if (!dateStr && previewDates) { dateStr = previewDates; headerIsSample = true; }

    const hasHeader = !!(petName || dateStr);
    const hasFooter = !!(nickname || familyName);

    // ── Font sizes ──

    const nameSize = Math.round(30 * scale);
    const dateSize = Math.round(10.5 * scale);
    const nickSize = Math.round(13.5 * scale);
    const famSize = Math.round(10 * scale);
    // Poem carries the insert now that dates are on the frame — give it presence
    const poemBaseSize = (nameOnFrame ? 16 : 13) * scale;

    // ── Measure fixed element heights ──

    var headerH = (petName ? nameSize * 1.2 : 0)
                + (dateStr ? dateSize * 1.6 : 0)
                + (hasHeader ? 6 * scale : 0);

    var footerH = (hasFooter ? 6 * scale : 0)
                + (nickname ? nickSize * 1.6 : 0)
                + (familyName ? famSize * 1.5 : 0);

    // ── Measure poem at a given font size ──

    function measurePoem(fontSize) {
      var lh = fontSize * 1.55;
      var blankH = lh * 0.5;
      ctx.font = '300 ' + Math.round(fontSize) + 'px "Cormorant Garamond", serif';
      var lines = wrapText(ctx, poemText, maxTextWidth * 0.92);
      var total = 0;
      for (var i = 0; i < lines.length; i++) {
        total += lines[i] === '' ? blankH : lh;
      }
      return { lines: lines, lineH: lh, blankH: blankH, totalH: total, fontSize: fontSize };
    }

    // ── Adaptive layout ──

    var tiers = [
      { marginPct: 0.09, pad: 14 * scale },
      { marginPct: 0.06, pad: 10 * scale },
      { marginPct: 0.04, pad: 6 * scale },
      { marginPct: 0.025, pad: 3 * scale }
    ];

    var margin, pad, poem;

    if (poemText) {
      var fullPoem = measurePoem(poemBaseSize);
      var fitted = false;

      for (var t = 0; t < tiers.length; t++) {
        var m = h * tiers[t].marginPct;
        var total = m + headerH + tiers[t].pad + fullPoem.totalH + tiers[t].pad + footerH + m;
        if (total <= h) {
          margin = m;
          pad = tiers[t].pad;
          poem = fullPoem;
          fitted = true;
          break;
        }
      }

      if (!fitted) {
        var last = tiers[tiers.length - 1];
        margin = h * last.marginPct;
        pad = last.pad;
        var available = h - margin * 2 - headerH - pad * 2 - footerH;

        // Shrink the poem until it fits the panel. The poem is the product, so
        // we hold its size as long as we can, but a tribute must NEVER be
        // clipped — so we keep going to a legible floor (60%) rather than
        // stopping at 82% and letting the text spill past the footer. A longer
        // "letter" in a short portrait panel lands here; balancing keeps the
        // line count minimal so it settles at a comfortable size.
        poem = fullPoem;
        for (var pct = 98; pct >= 60; pct -= 2) {
          var p = measurePoem(poemBaseSize * pct / 100);
          poem = p;
          if (p.totalH <= available) break;
        }
      }
    } else {
      margin = h * tiers[0].marginPct;
      pad = tiers[0].pad;
      poem = { lines: [], lineH: 0, blankH: 0, totalH: 0, fontSize: poemBaseSize };
    }

    // ── Draw ──

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    var y = margin;

    // Header (sample name/dates render muted so they read as placeholders)
    if (petName) {
      ctx.font = '500 ' + nameSize + 'px "Cormorant Garamond", serif';
      ctx.fillStyle = headerIsSample ? mixHex(colors.name, colors.bg, 0.55) : colors.name;
      ctx.fillText(petName, cx, y, maxTextWidth);
      y += nameSize * 1.2;
    }

    if (dateStr) {
      ctx.font = '300 ' + dateSize + 'px "Cormorant Garamond", serif';
      ctx.fillStyle = headerIsSample ? mixHex(colors.dates, colors.bg, 0.5) : colors.dates;
      ctx.fillText(dateStr, cx, y, maxTextWidth);
      y += dateSize * 1.6;
    }

    if (hasHeader) {
      drawDivider(ctx, cx, y + 2 * scale, 28 * scale, colors.divider, scale);
      y += 6 * scale + pad;
    }

    // Poem – vertically centered between header and footer
    if (poem.lines.length > 0) {
      var footerTop = h - margin - footerH;
      var zoneH = footerTop - pad - y;
      var startY = y + Math.max(0, (zoneH - poem.totalH) / 2);

      ctx.font = '300 ' + Math.round(poem.fontSize) + 'px "Cormorant Garamond", serif';
      // Sample poem renders muted so it reads as a placeholder
      ctx.fillStyle = poemIsSample ? mixHex(colors.poem, colors.bg, 0.55) : colors.poem;

      var py = startY;
      for (var i = 0; i < poem.lines.length; i++) {
        if (poem.lines[i] === '') {
          py += poem.blankH;
        } else {
          ctx.fillText(poem.lines[i], cx, py, maxTextWidth);
          py += poem.lineH;
        }
      }
    }

    // Footer – anchored to bottom margin
    var fy = h - margin;
    ctx.textBaseline = 'bottom';

    if (familyName) {
      ctx.font = 'italic 300 ' + famSize + 'px "Cormorant Garamond", serif';
      ctx.fillStyle = colors.family;
      ctx.fillText(famPrefix + ' ' + familyName, cx, fy, maxTextWidth);
      fy -= famSize * 1.5;
    }

    if (nickname) {
      ctx.font = 'italic 400 ' + nickSize + 'px "Cormorant Garamond", serif';
      ctx.fillStyle = colors.nickname;
      var displayNick = nickname.startsWith('"') ? nickname : '\u201C' + nickname + '\u201D';
      ctx.fillText(displayNick, cx, fy, maxTextWidth);
      fy -= nickSize * 1.6;
    }

    if (hasFooter) {
      drawDivider(ctx, cx, fy, 28 * scale, colors.divider, scale);
    }
  }

  // ── Text Panel (3rd panel custom message) ──────────────────

  function renderTextPanel(ctx, canvas, panelId) {
    const w = canvas.width;
    const h = canvas.height;
    if (w === 0 || h === 0) return;

    const bg = styleColors?.tribute?.background || '#1a1a1a';
    const textColor = styleColors?.tribute?.poem || '#C4A882';

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const customText = fields[`panel2Text`] || '';
    if (!customText) {
      ctx.fillStyle = 'rgba(255,255,255,0.1)';
      ctx.font = `400 ${Math.round(Math.min(w, h) * 0.05)}px "Source Sans 3", sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Custom text', w / 2, h / 2);
      return;
    }

    const scale = Math.min(w / 400, h / 260);
    const fontSize = 13 * scale;
    const lineH = fontSize * 1.55;
    const maxTextWidth = w * 0.8;
    const cx = w / 2;

    ctx.font = '300 ' + Math.round(fontSize) + 'px "Cormorant Garamond", serif';
    ctx.fillStyle = textColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const lines = wrapText(ctx, customText, maxTextWidth);
    const totalH = lines.length * lineH;
    let y = (h - totalH) / 2;

    for (const line of lines) {
      if (line === '') {
        y += lineH * 0.5;
      } else {
        ctx.fillText(line, cx, y, maxTextWidth);
        y += lineH;
      }
    }
  }

  function drawDivider(ctx, cx, y, halfWidth, color, scale) {
    ctx.beginPath();
    ctx.moveTo(cx - halfWidth, y);
    ctx.lineTo(cx + halfWidth, y);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(1, 0.8 * scale);
    ctx.globalAlpha = 0.4;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── Helpers ────────────────────────────────────────────────

  function drawCoverImage(ctx, img, photoData, dx, dy, dw, dh) {
    var imgAspect = img.naturalWidth / img.naturalHeight;
    var boxAspect = dw / dh;

    var sw, sh;

    if (imgAspect > boxAspect) {
      sh = img.naturalHeight;
      sw = sh * boxAspect;
    } else {
      sw = img.naturalWidth;
      sh = sw / boxAspect;
    }

    // Apply zoom
    var zoom = (photoData && photoData.zoom) || 1;
    sw = sw / zoom;
    sh = sh / zoom;

    // Apply pan (0-1 range, 0.5 = centered)
    var px = (photoData && typeof photoData.panX === 'number') ? photoData.panX : 0.5;
    var py = (photoData && typeof photoData.panY === 'number') ? photoData.panY : 0.5;

    var sx = (img.naturalWidth - sw) * px;
    var sy = (img.naturalHeight - sh) * py;

    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  // ── Balanced word-wrap ─────────────────────────────────────
  //
  // The poem/letter arrives with the author's own line breaks (one per \n).
  // We only ever re-wrap an authored line when it is wider than the panel.
  // When that happens a greedy wrap crams the first line full and strands
  // whatever is left — often a single word — alone on the next line. That
  // lone-word line is exactly the "one word on its own line" the tribute must
  // never show.
  //
  // Instead we split an over-wide line into the FEWEST lines that fit, then
  // balance their widths so the break lands near the middle (the same idea as
  // CSS `text-wrap: balance`). Two roughly equal lines never leave an orphan.
  // Because we keep the fewest-lines count, the block is never taller than a
  // greedy wrap — balancing costs no vertical space.
  //
  // NOTE: mirrors wrapText/balanceLine in src/services/tributeRenderer.js
  // (the SVG print path). Keep the two algorithms in sync.

  function greedyPack(words, limit, measure) {
    var lines = [];
    var cur = '';
    for (var i = 0; i < words.length; i++) {
      var test = cur ? cur + ' ' + words[i] : words[i];
      if (cur && measure(test) > limit) {
        lines.push(cur);
        cur = words[i];
      } else {
        cur = test;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  function balanceLine(words, limit, measure) {
    // Fits as-is → one line, nothing to balance.
    if (measure(words.join(' ')) <= limit) return [words.join(' ')];

    // Fewest lines this content needs at the true width limit.
    var need = greedyPack(words, limit, measure).length;

    // The longest single word is a hard floor for the achievable line width.
    var lo = 0;
    for (var i = 0; i < words.length; i++) lo = Math.max(lo, measure(words[i]));
    var hi = limit;

    // Binary-search the smallest width that still packs into `need` lines.
    // Packing at that width yields evenly balanced lines, all within `limit`.
    for (var iter = 0; iter < 24 && hi - lo > 0.5; iter++) {
      var mid = (lo + hi) / 2;
      if (greedyPack(words, mid, measure).length <= need) hi = mid;
      else lo = mid;
    }
    return greedyPack(words, hi, measure);
  }

  function wrapText(ctx, text, maxWidth) {
    var measure = function (s) { return ctx.measureText(s).width; };
    var paragraphs = text.split('\n');
    var allLines = [];

    for (var p = 0; p < paragraphs.length; p++) {
      var para = paragraphs[p];
      if (!para.trim()) {
        allLines.push('');
        continue;
      }

      var words = para.split(/\s+/);
      var wrapped = balanceLine(words, maxWidth, measure);
      for (var i = 0; i < wrapped.length; i++) allLines.push(wrapped[i]);
    }

    return allLines;
  }

  function roundedRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

})();
