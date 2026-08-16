/**
 * poem-generator.js – Frontend for the free Pet Memorial Poem Generator tool.
 * Posts the memories the visitor shares to the existing /api/poems/generate
 * endpoint (stub-safe when no API key is set) and renders the result.
 */
(function () {
  const form = document.getElementById('poem-form');
  if (!form) return;

  const loadingSection = document.getElementById('poem-loading');
  const resultsSection = document.getElementById('poem-results');
  const resultText = document.querySelector('.poem-result-text');
  const generateBtn = document.getElementById('poem-generate-btn');
  const copyBtn = document.getElementById('poem-copy-btn');
  const regenBtn = document.getElementById('poem-regen-btn');
  const ctas = document.querySelectorAll('[data-poem-cta]');

  let lastPoem = '';

  // The handoff to the designer. customizer.js reads this key and opens with
  // the answers and the poem already in place, so nobody retypes their memories
  // or gambles on a regeneration that reads differently from the one they love.
  const HANDOFF_KEY = 'sbm-generated-poem';

  function saveHandoff(payload, poem) {
    try {
      localStorage.setItem(HANDOFF_KEY, JSON.stringify({
        v: 1,
        savedAt: Date.now(),
        category: payload.category,
        format: payload.format,
        poem: poem,
        fields: {
          petName: payload.petName,
          petType: payload.petType,
          personality: payload.personality,
          favoriteMemory: payload.favoriteMemory,
          favoriteThing: payload.favoriteThing
        }
      }));
    } catch (e) { /* private mode */ }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    // Fallback for older browsers
    return new Promise(function (resolve) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
      resolve();
    });
  }

  async function generate() {
    const petName = document.getElementById('poem-name').value.trim();
    if (!petName) {
      document.getElementById('poem-name').focus();
      return;
    }

    const payload = {
      category: 'pet',
      petName: petName,
      petType: document.getElementById('poem-type').value,
      personality: document.getElementById('poem-personality').value.trim(),
      favoriteMemory: document.getElementById('poem-memory').value.trim(),
      favoriteThing: document.getElementById('poem-thing').value.trim(),
      format: (form.querySelector('input[name="poem-format"]:checked') || {}).value || 'poem'
    };

    generateBtn.disabled = true;
    generateBtn.textContent = 'Writing...';
    resultsSection.style.display = 'none';
    loadingSection.style.display = 'block';

    try {
      const res = await fetch('/api/poems/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || 'Something went wrong writing the poem. Please try again.');
        return;
      }

      lastPoem = data.poem || '';
      resultText.textContent = lastPoem;
      saveHandoff(payload, lastPoem);

      loadingSection.style.display = 'none';
      resultsSection.style.display = 'block';
      resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

      if (typeof gtag === 'function') {
        gtag('event', 'poem_generated', { format: payload.format, pet_type: payload.petType });
      }
    } catch (err) {
      console.error('Poem generation failed:', err);
      alert('Something went wrong writing the poem. Please try again.');
    } finally {
      loadingSection.style.display = 'none';
      generateBtn.disabled = false;
      generateBtn.textContent = 'Write My Poem';
    }
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    generate();
  });

  if (regenBtn) {
    regenBtn.addEventListener('click', function () { generate(); });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      copyToClipboard(lastPoem).then(function () {
        copyBtn.textContent = 'Copied!';
        setTimeout(function () { copyBtn.textContent = 'Copy poem'; }, 2000);
      });
    });
  }

  // Copy the poem on the way to the designer so it can be pasted straight in.
  // Both the framed CTA and the quieter digital-keepsake down-sell land in the
  // designer, so both carry the poem across.
  ctas.forEach(function (cta) {
    cta.addEventListener('click', function () {
      if (lastPoem) { copyToClipboard(lastPoem); }
    });
  });
})();
