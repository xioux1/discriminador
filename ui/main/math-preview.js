/* ─── Math Live Preview ───────────────────────────────────────────────────── */
/* Global script — exposes window.MathPreview                                  */
/* Renders (num)/(den) as CSS fractions and base^exp as superscripts in a      */
/* read-only preview div shown below the textarea when math mode is active.    */

(function () {
  'use strict';

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // Renders one line with math patterns replaced by HTML.
  // Supported patterns:
  //   (num)/(den)   → CSS fraction
  //   ^{exp}        → superscript (multi-char, e.g. ^{2x+1})
  //   ^word         → superscript (e.g. ^x, ^12, ^alpha)
  //   _{sub}        → subscript  (multi-char, e.g. _{n-1})
  //   _word         → subscript  (e.g. _1, _n)
  function renderMathLine(line) {
    var pattern = /\(([^()]*)\)\/\(([^()]*)\)|\^{([^{}]*)}|\^([a-zA-Z0-9]+)|_{([^{}]*)}|_([a-zA-Z0-9]+)/g;
    var result = '';
    var lastIndex = 0;
    var match;

    while ((match = pattern.exec(line)) !== null) {
      result += escapeHtml(line.slice(lastIndex, match.index));

      if (match[1] !== undefined) {
        // (num)/(den) — render as stacked fraction
        result +=
          '<span class="mp-frac">' +
            '<span class="mp-num">' + renderMathLine(match[1]) + '</span>' +
            '<span class="mp-den">' + renderMathLine(match[2]) + '</span>' +
          '</span>';
      } else if (match[3] !== undefined) {
        // ^{exp}
        result += '<sup>' + renderMathLine(match[3]) + '</sup>';
      } else if (match[4] !== undefined) {
        // ^word
        result += '<sup>' + escapeHtml(match[4]) + '</sup>';
      } else if (match[5] !== undefined) {
        // _{sub}
        result += '<sub>' + renderMathLine(match[5]) + '</sub>';
      } else if (match[6] !== undefined) {
        // _word
        result += '<sub>' + escapeHtml(match[6]) + '</sub>';
      }

      lastIndex = pattern.lastIndex;
    }

    result += escapeHtml(line.slice(lastIndex));
    return result;
  }

  function renderMathText(text) {
    return text.split('\n').map(renderMathLine).join('<br>');
  }

  // Returns true when the text contains at least one supported math pattern.
  function hasMathPatterns(text) {
    return /\([^()]*\)\/\([^()]*\)|\^[{a-zA-Z0-9]|_\{|_[a-zA-Z0-9]/.test(text);
  }

  // Attaches a live preview div right after `textarea`.
  // `isActiveFn` is called on each update to decide whether math mode is on.
  function attachMathPreview(textarea, isActiveFn) {
    if (!textarea) return;

    var container = document.createElement('div');
    container.className = 'math-preview-container hidden';
    container.setAttribute('aria-hidden', 'true');

    var label = document.createElement('span');
    label.className = 'math-preview-label';
    label.textContent = 'Preview';

    var content = document.createElement('div');
    content.className = 'math-preview-content';

    container.appendChild(label);
    container.appendChild(content);

    // Insert immediately after the textarea in the DOM
    textarea.parentNode.insertBefore(container, textarea.nextSibling);

    function update() {
      if (!isActiveFn()) {
        container.classList.add('hidden');
        return;
      }
      var text = textarea.value;
      if (!text.trim() || !hasMathPatterns(text)) {
        container.classList.add('hidden');
        return;
      }
      content.innerHTML = renderMathText(text);
      container.classList.remove('hidden');
    }

    textarea.addEventListener('input', update);
    // Store reference so external code can trigger an update
    textarea._mathPreviewUpdate = update;
  }

  window.MathPreview = {
    attach: attachMathPreview,
    render: renderMathText,
    // Call after a programmatic value change or mode switch
    refresh: function (textarea) {
      if (textarea && typeof textarea._mathPreviewUpdate === 'function') {
        textarea._mathPreviewUpdate();
      }
    }
  };
})();
