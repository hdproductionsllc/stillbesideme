/**
 * sympathy.js – Frontend for the Sympathy Message Helper tool.
 */
(function () {
  const form = document.getElementById('sympathy-form');
  const resultsSection = document.getElementById('sympathy-results');
  const loadingSection = document.getElementById('sympathy-loading');
  const generateBtn = document.getElementById('sympathy-generate-btn');
  const messageCards = document.querySelectorAll('.message-card-text');
  const cardLabels = ['Formal', 'Warm', 'Personal'];

  if (!form) return;

  form.addEventListener('submit', async function (e) {
    e.preventDefault();

    const relationship = document.getElementById('sympathy-relationship').value;
    const name = document.getElementById('sympathy-name').value.trim();
    const context = document.getElementById('sympathy-context').value.trim();

    if (!relationship) return;

    generateBtn.disabled = true;
    generateBtn.textContent = 'Generating...';
    resultsSection.style.display = 'none';
    loadingSection.style.display = 'block';

    try {
      const res = await fetch('/api/sympathy/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ relationship, name, context })
      });

      const data = await res.json();

      if (!res.ok) {
        alert(data.error || 'Something went wrong. Please try again.');
        loadingSection.style.display = 'none';
        generateBtn.disabled = false;
        generateBtn.textContent = 'Generate Messages';
        return;
      }

      // Display messages
      data.messages.forEach(function (msg, i) {
        if (messageCards[i]) {
          messageCards[i].textContent = msg;
        }
      });

      loadingSection.style.display = 'none';
      resultsSection.style.display = 'block';
    } catch (err) {
      console.error('Generation failed:', err);
      alert('Something went wrong. Please try again.');
      loadingSection.style.display = 'none';
    }

    generateBtn.disabled = false;
    generateBtn.textContent = 'Generate New Messages';
  });

  // Copy-to-clipboard buttons
  document.querySelectorAll('.message-card-copy').forEach(function (btn, i) {
    btn.addEventListener('click', function () {
      const text = messageCards[i].textContent;
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
      }).catch(function () {
        // Fallback for older browsers
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        btn.textContent = 'Copied!';
        setTimeout(function () { btn.textContent = 'Copy'; }, 2000);
      });
    });
  });
})();
