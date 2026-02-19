/**
 * Preview.js — 2-panel tribute renderer.
 *
 * Renders a photo panel and tribute text panel side by side (or stacked)
 * on separate canvases. The CSS frame/mat wraps around both panels.
 *
 * Photo panel: Pet photo with cover-fit and smart crop positioning.
 * Tribute panel: Name, dates, divider, poem, nickname, family attribution.
 */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────

  let photoCanvas, photoCtx;
  let tributeCanvas, tributeCtx;
  let template = null;
  let photo = null;          // { image, position }
  let fields = {};           // fieldId → value
  let styleColors = null;    // current style variant colors
  let fontsLoaded = false;
  let renderQueued = false;

  // ── Public API ─────────────────────────────────────────────

  window.PreviewRenderer = {
    init,
    setPhoto,
    setField,
    setStyle,
    setLayout,
    getFields: () => ({ ...fields }),
    render
  };

  // ── Initialization ─────────────────────────────────────────

  function init(photoCanvasId, tributeCanvasId, tmpl) {
    photoCanvas = document.getElementById(photoCanvasId);
    tributeCanvas = document.getElementById(tributeCanvasId);

    if (!photoCanvas || !tributeCanvas) return;

    photoCtx = photoCanvas.getContext('2d');
    tributeCtx = tributeCanvas.getContext('2d');

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
      // Also load italic
      loads.push(document.fonts.load(`italic 300 48px "Cormorant Garamond"`));
      loads.push(document.fonts.load(`italic 400 48px "Cormorant Garamond"`));
      await Promise.all(loads);
    } catch (e) {
      // Some weights may not exist
    }
  }

  // ── Data Setters ───────────────────────────────────────────

  function setPhoto(imageUrl, position) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      photo = { image: img, position: position || '50% 50%' };
      queueRender();
    };
    img.src = imageUrl;
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
    const panels = document.getElementById('preview-panels');
    if (!panels) return;

    if (layoutKey === 'stacked') {
      panels.classList.add('layout-stacked');
    } else {
      panels.classList.remove('layout-stacked');
    }

    // Canvases need to re-measure after the CSS layout change
    requestAnimationFrame(() => {
      sizeCanvases();
      queueRender();
    });
  }

  // ── Canvas Sizing ──────────────────────────────────────────

  function sizeCanvases() {
    if (!photoCanvas || !tributeCanvas) return;

    const dpr = window.devicePixelRatio || 1;

    // Photo panel
    const photoPanel = photoCanvas.parentElement;
    const pw = photoPanel.clientWidth;
    const ph = photoPanel.clientHeight;
    photoCanvas.width = Math.round(pw * dpr);
    photoCanvas.height = Math.round(ph * dpr);
    photoCanvas.style.width = pw + 'px';
    photoCanvas.style.height = ph + 'px';

    // Tribute panel
    const tributePanel = tributeCanvas.parentElement;
    const tw = tributePanel.clientWidth;
    const th = tributePanel.clientHeight;
    tributeCanvas.width = Math.round(tw * dpr);
    tributeCanvas.height = Math.round(th * dpr);
    tributeCanvas.style.width = tw + 'px';
    tributeCanvas.style.height = th + 'px';
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
    if (!photoCanvas || !tributeCanvas) return;
    renderPhotoPanel();
    renderTributePanel();
  }

  // ── Photo Panel ────────────────────────────────────────────

  function renderPhotoPanel() {
    const ctx = photoCtx;
    const w = photoCanvas.width;
    const h = photoCanvas.height;

    // Background
    const bg = styleColors?.tribute?.background || '#1a1a1a';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    if (photo && photo.image) {
      drawCoverImage(ctx, photo.image, photo.position, 0, 0, w, h);
    } else {
      renderPhotoPlaceholder(ctx, w, h);
    }
  }

  function renderPhotoPlaceholder(ctx, w, h) {
    ctx.fillStyle = 'rgba(255,255,255,0.03)';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const iconSize = Math.min(w, h) * 0.12;

    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = iconSize * 0.06;

    // Camera icon
    ctx.beginPath();
    roundedRect(ctx, cx - iconSize, cy - iconSize * 0.7, iconSize * 2, iconSize * 1.4, iconSize * 0.15);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, iconSize * 0.4, 0, Math.PI * 2);
    ctx.stroke();

    // Label
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.font = `400 ${Math.round(iconSize * 0.3)}px "Source Sans 3", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText('Upload their photo', cx, cy + iconSize * 1.1);
  }

  // ── Tribute Panel ──────────────────────────────────────────

  function renderTributePanel() {
    const ctx = tributeCtx;
    const w = tributeCanvas.width;
    const h = tributeCanvas.height;
    const dpr = window.devicePixelRatio || 1;

    // Colors from style variant
    const colors = {
      bg: styleColors?.tribute?.background || '#1a1a1a',
      name: styleColors?.tribute?.name || '#FAF8F5',
      dates: styleColors?.tribute?.dates || '#9B9590',
      divider: styleColors?.tribute?.divider || '#C4A882',
      poem: styleColors?.tribute?.poem || '#C4A882',
      nickname: styleColors?.tribute?.nickname || '#9B9590',
      family: styleColors?.tribute?.family || '#9B9590'
    };

    // Background — radial gradient for parchment feel
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, h);

    // Add subtle warmth to the center
    const gradient = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, h * 0.6);
    gradient.addColorStop(0, 'rgba(196, 168, 130, 0.04)');
    gradient.addColorStop(1, 'rgba(196, 168, 130, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, w, h);

    // Scale factor for responsive sizing
    const scale = w / 400; // base at 400px wide

    // Centering x
    const cx = w / 2;
    let y = h * 0.12; // Start from 12% down
    const padX = w * 0.1;
    const maxTextWidth = w - padX * 2;

    // Pet Name
    const petName = fields.petName || '';
    if (petName) {
      ctx.font = `500 ${Math.round(32 * scale)}px "Cormorant Garamond", serif`;
      ctx.fillStyle = colors.name;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(petName, cx, y, maxTextWidth);
      y += 38 * scale;
    }

    // Dates
    const birthDate = fields.birthDate || '';
    const passDate = fields.passDate || '';
    let dateStr = '';
    if (birthDate && passDate) {
      dateStr = `${birthDate} — ${passDate}`;
    } else if (birthDate) {
      dateStr = birthDate;
    } else if (passDate) {
      dateStr = passDate;
    }
    if (dateStr) {
      ctx.font = `400 ${Math.round(12 * scale)}px "Source Sans 3", sans-serif`;
      ctx.fillStyle = colors.dates;
      ctx.textAlign = 'center';
      ctx.letterSpacing = '0.08em';
      ctx.fillText(dateStr, cx, y, maxTextWidth);
      y += 22 * scale;
    }

    // Divider 1
    if (petName || dateStr) {
      y += 8 * scale;
      ctx.beginPath();
      ctx.moveTo(cx - 25 * scale, y);
      ctx.lineTo(cx + 25 * scale, y);
      ctx.strokeStyle = colors.divider;
      ctx.lineWidth = 1 * scale;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
      y += 16 * scale;
    }

    // Poem
    const poemText = fields.poemText || '';
    if (poemText) {
      ctx.font = `300 ${Math.round(11.5 * scale)}px "Cormorant Garamond", serif`;
      ctx.fillStyle = colors.poem;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';

      const poemLines = wrapText(ctx, poemText, maxTextWidth * 0.92);
      const poemLineHeight = 16 * scale;

      // Calculate space needed for poem + bottom elements
      const poemHeight = poemLines.length * poemLineHeight;
      const bottomSpace = 60 * scale; // nickname + family + divider
      const availableForPoem = h - y - bottomSpace;

      // If poem is taller than available space, shrink font
      let actualPoemLineHeight = poemLineHeight;
      let actualPoemLines = poemLines;
      if (poemHeight > availableForPoem && availableForPoem > 0) {
        const shrinkFactor = Math.max(0.65, availableForPoem / poemHeight);
        const newSize = Math.round(11.5 * scale * shrinkFactor);
        actualPoemLineHeight = poemLineHeight * shrinkFactor;
        ctx.font = `300 ${newSize}px "Cormorant Garamond", serif`;
        actualPoemLines = wrapText(ctx, poemText, maxTextWidth * 0.92);
      }

      for (let i = 0; i < actualPoemLines.length; i++) {
        ctx.fillText(actualPoemLines[i], cx, y + i * actualPoemLineHeight, maxTextWidth);
      }
      y += actualPoemLines.length * actualPoemLineHeight;
    }

    // Bottom section — positioned from bottom
    let bottomY = h * 0.88;

    // Family attribution
    const familyName = fields.familyName || '';
    if (familyName) {
      ctx.font = `400 ${Math.round(9 * scale)}px "Source Sans 3", sans-serif`;
      ctx.fillStyle = colors.family;
      ctx.textAlign = 'center';
      ctx.fillText(`Beloved companion of ${familyName}`, cx, bottomY, maxTextWidth);
      bottomY -= 16 * scale;
    }

    // Nickname
    const nickname = fields.petNicknames || '';
    if (nickname) {
      ctx.font = `italic 300 ${Math.round(10 * scale)}px "Cormorant Garamond", serif`;
      ctx.fillStyle = colors.nickname;
      ctx.textAlign = 'center';
      // Wrap in quotes if not already
      const displayNick = nickname.startsWith('"') ? nickname : `"${nickname}"`;
      ctx.fillText(displayNick, cx, bottomY, maxTextWidth);
      bottomY -= 16 * scale;
    }

    // Divider 2 (above nickname/family)
    if (nickname || familyName) {
      bottomY -= 4 * scale;
      ctx.beginPath();
      ctx.moveTo(cx - 25 * scale, bottomY);
      ctx.lineTo(cx + 25 * scale, bottomY);
      ctx.strokeStyle = colors.divider;
      ctx.lineWidth = 1 * scale;
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  function drawCoverImage(ctx, img, position, dx, dy, dw, dh) {
    const imgAspect = img.naturalWidth / img.naturalHeight;
    const boxAspect = dw / dh;

    let sw, sh, sx, sy;

    if (imgAspect > boxAspect) {
      sh = img.naturalHeight;
      sw = sh * boxAspect;
    } else {
      sw = img.naturalWidth;
      sh = sw / boxAspect;
    }

    const [pxStr, pyStr] = (position || '50% 50%').split(/\s+/);
    const px = parseFloat(pxStr) / 100;
    const py = parseFloat(pyStr) / 100;

    sx = (img.naturalWidth - sw) * px;
    sy = (img.naturalHeight - sh) * py;

    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  function wrapText(ctx, text, maxWidth) {
    const paragraphs = text.split('\n');
    const allLines = [];

    for (const para of paragraphs) {
      if (!para.trim()) {
        allLines.push('');
        continue;
      }

      const words = para.split(/\s+/);
      let currentLine = '';

      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        const metrics = ctx.measureText(testLine);

        if (metrics.width > maxWidth && currentLine) {
          allLines.push(currentLine);
          currentLine = word;
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
