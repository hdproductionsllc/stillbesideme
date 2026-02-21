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
 * compress margins and spacing first. The poem font only shrinks as a
 * last resort, and never below 82%.
 */

(function () {
  'use strict';

  // ── Layout Definitions ────────────────────────────────────
  //
  // Each layout specifies CSS Grid tracks and named areas.
  // `columns` / `rows` are arrays of fr values.
  // `areas` is a 2-D array of grid-area names (row-major).

  const LAYOUTS = {
    // 2-panel
    'side-by-side': {
      panels: 2,
      columns: [1, 1],
      rows: [1],
      areas: [['photo', 'tribute']],
      aspectRatio: '5/3.2'
    },
    'stacked': {
      panels: 2,
      columns: [1],
      rows: [1, 1],
      areas: [['photo'], ['tribute']],
      aspectRatio: '4/5'
    },
    // 3-panel hero
    'hero-left': {
      panels: 3,
      columns: [1.15, 1],
      rows: [1, 1],
      areas: [['photo', 'panel2'], ['photo', 'tribute']],
      aspectRatio: '5/3.8'
    },
    'hero-top': {
      panels: 3,
      columns: [1, 1],
      rows: [1.3, 1],
      areas: [['photo', 'photo'], ['panel2', 'tribute']],
      aspectRatio: '4/5'
    },
    // 3-panel photos+tribute
    'photos-left': {
      panels: 3,
      columns: [1, 1.15],
      rows: [1, 1],
      areas: [['photo', 'tribute'], ['panel2', 'tribute']],
      aspectRatio: '5/3.8'
    },
    'tribute-top': {
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
  let currentLayout = 'side-by-side';

  // panels Map: areaName -> { canvas, ctx, type, panelEl }
  const panels = new Map();

  // photos object: panelId -> { image, position, zoom, panX, panY }
  const photos = {};

  // Frame size from selected product SKU (e.g. [11, 14] for "framed-11x14")
  let frameDims = null;

  // Custom fr ratios (user-dragged dividers): layoutKey -> { columns: [...], rows: [...] }
  const customRatios = {};

  let fields = {};           // fieldId → value
  let styleColors = null;    // current style variant colors
  let fontsLoaded = false;
  let renderQueued = false;

  // ── Public API ─────────────────────────────────────────────

  window.PreviewRenderer = {
    init,
    setPhoto,
    setPhotoCrop,
    getPhotoCrop,
    getPhotoCanvas,
    setField,
    setStyle,
    setLayout,
    setFrameSize,
    getFields: () => ({ ...fields }),
    render,
    getCurrentFrValues,
    setCustomRatios,
    resetCustomRatios,
    getCustomRatios: () => JSON.parse(JSON.stringify(customRatios)),
    getPanels: () => panels,
    getLayouts: () => LAYOUTS,
    getCurrentLayout: () => currentLayout,
    getContainer: () => container
  };

  // ── Initialization ─────────────────────────────────────────

  function init(containerId, tmpl) {
    container = document.getElementById(containerId);
    if (!container) return;

    template = tmpl;

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
    const layout = LAYOUTS[layoutKey];
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
    const layout = LAYOUTS[layoutKey];
    if (!layout || !container) return;

    const ratios = customRatios[layoutKey];
    const cols = ratios ? ratios.columns : layout.columns;
    const rows = ratios ? ratios.rows : layout.rows;

    container.style.gridTemplateColumns = cols.map(v => v + 'fr').join(' ');
    container.style.gridTemplateRows = rows.map(v => v + 'fr').join(' ');
    container.style.gridTemplateAreas = layout.areas.map(
      row => '"' + row.join(' ') + '"'
    ).join(' ');

    // Use frame size if selected, otherwise fall back to layout default
    if (frameDims) {
      // Determine if this layout is landscape or portrait from its default ratio
      var parts = layout.aspectRatio.split('/');
      var isLandscape = parseFloat(parts[0]) > parseFloat(parts[1]);
      var w = isLandscape ? Math.max(frameDims[0], frameDims[1]) : Math.min(frameDims[0], frameDims[1]);
      var h = isLandscape ? Math.min(frameDims[0], frameDims[1]) : Math.max(frameDims[0], frameDims[1]);
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

  function setField(fieldId, value) {
    fields[fieldId] = value;
    queueRender();
  }

  function setStyle(variant) {
    styleColors = variant;
    queueRender();
  }

  function setLayout(layoutKey) {
    if (!LAYOUTS[layoutKey]) return;
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
    const layout = LAYOUTS[currentLayout];
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
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const iconSize = Math.min(w, h) * 0.12;

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = iconSize * 0.06;

    ctx.beginPath();
    roundedRect(ctx, cx - iconSize, cy - iconSize * 0.7, iconSize * 2, iconSize * 1.4, iconSize * 0.15);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, iconSize * 0.4, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.15)';
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

    const petName = fields[nameField] || '';
    const nickname = fields[nickField] || '';
    const familyName = fields[famField] || '';
    const poemText = fields[poemField] || '';
    const birthDate = fields[birthField] || '';
    const passDate = fields[passField] || '';
    let dateStr = '';
    if (birthDate && passDate) dateStr = birthDate + ' \u2013 ' + passDate;
    else if (birthDate) dateStr = birthDate;
    else if (passDate) dateStr = passDate;

    const hasHeader = !!(petName || dateStr);
    const hasFooter = !!(nickname || familyName);

    // ── Font sizes ──

    const nameSize = Math.round(30 * scale);
    const dateSize = Math.round(10.5 * scale);
    const nickSize = Math.round(10 * scale);
    const famSize = Math.round(9 * scale);
    const poemBaseSize = 13 * scale;

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

        poem = fullPoem;
        for (var pct = 98; pct >= 82; pct -= 2) {
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

    // Header
    if (petName) {
      ctx.font = '500 ' + nameSize + 'px "Cormorant Garamond", serif';
      ctx.fillStyle = colors.name;
      ctx.fillText(petName, cx, y, maxTextWidth);
      y += nameSize * 1.2;
    }

    if (dateStr) {
      ctx.font = '300 ' + dateSize + 'px "Cormorant Garamond", serif';
      ctx.fillStyle = colors.dates;
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
      ctx.fillStyle = colors.poem;

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

  function wrapText(ctx, text, maxWidth) {
    var paragraphs = text.split('\n');
    var allLines = [];

    for (var p = 0; p < paragraphs.length; p++) {
      var para = paragraphs[p];
      if (!para.trim()) {
        allLines.push('');
        continue;
      }

      var words = para.split(/\s+/);
      var currentLine = '';

      for (var i = 0; i < words.length; i++) {
        var testLine = currentLine ? currentLine + ' ' + words[i] : words[i];
        var metrics = ctx.measureText(testLine);

        if (metrics.width > maxWidth && currentLine) {
          allLines.push(currentLine);
          currentLine = words[i];
        } else {
          currentLine = testLine;
        }
      }
      if (currentLine) {
        allLines.push(currentLine);
      }
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
