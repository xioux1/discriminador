/* ─── Math Inline Overlay ───────────────────────────────────────────────────
   Exposes window.MathPreview.
   Positions a formatted div exactly over the textarea. The textarea text
   becomes transparent (cursor stays visible) so the user sees formatted
   math right where they type.                                              */

(function () {
  'use strict';

  function escapeHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Renders one line replacing math patterns with HTML.
  // Patterns:
  //   (num)/(den)  → stacked fraction
  //   ^{exp}       → superscript, multi-char  e.g. ^{2x+1}
  //   ^word        → superscript, single word  e.g. ^x  ^12
  //   _{sub}       → subscript,  multi-char  e.g. _{n-1}
  //   _word        → subscript,  single word  e.g. _1  _n
  function renderMathLine(line) {
    var pattern = /\(([^()]*)\)\/\(([^()]*)\)|\^{([^{}]*)}|\^([a-zA-Z0-9]+)|_{([^{}]*)}|_([a-zA-Z0-9]+)/g;
    var result = '', lastIndex = 0, match;
    while ((match = pattern.exec(line)) !== null) {
      result += escapeHtml(line.slice(lastIndex, match.index));
      if (match[1] !== undefined) {
        result += '<span class="mp-frac"><span class="mp-num">' + renderMathLine(match[1]) +
                  '</span><span class="mp-den">' + renderMathLine(match[2]) + '</span></span>';
      } else if (match[3] !== undefined) {
        result += '<sup>' + renderMathLine(match[3]) + '</sup>';
      } else if (match[4] !== undefined) {
        result += '<sup>' + escapeHtml(match[4]) + '</sup>';
      } else if (match[5] !== undefined) {
        result += '<sub>' + renderMathLine(match[5]) + '</sub>';
      } else if (match[6] !== undefined) {
        result += '<sub>' + escapeHtml(match[6]) + '</sub>';
      }
      lastIndex = pattern.lastIndex;
    }
    return result + escapeHtml(line.slice(lastIndex));
  }

  function renderMathText(text) {
    return text.split('\n').map(renderMathLine).join('<br>');
  }

  // CSS properties copied from the textarea so the overlay text aligns exactly.
  var COPY_PROPS = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'tabSize'
  ];

  function syncStyles(textarea, overlay) {
    var cs = window.getComputedStyle(textarea);
    COPY_PROPS.forEach(function (p) { overlay.style[p] = cs[p]; });
    // Force border-box so offsetWidth/Height map directly to the overlay size.
    overlay.style.boxSizing   = 'border-box';
    overlay.style.borderStyle = 'solid';
    overlay.style.borderColor = 'transparent'; // same border thickness, invisible
    overlay.style.width       = textarea.offsetWidth  + 'px';
    overlay.style.height      = textarea.offsetHeight + 'px';
  }

  function attach(textarea, isActiveFn) {
    if (!textarea || textarea._mathOverlayAttached) return;
    textarea._mathOverlayAttached = true;

    // Wrap the textarea so we can position the overlay relative to it.
    var wrapper = document.createElement('div');
    wrapper.className = 'math-overlay-wrapper';
    textarea.parentNode.insertBefore(wrapper, textarea);
    wrapper.appendChild(textarea);

    // Overlay sits on top; pointer-events:none lets typing reach the textarea.
    var overlay = document.createElement('div');
    overlay.className = 'math-overlay math-overlay--off';
    overlay.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(overlay);

    function update() {
      if (!isActiveFn()) {
        overlay.classList.add('math-overlay--off');
        textarea.classList.remove('math-textarea--active');
        return;
      }
      syncStyles(textarea, overlay);
      overlay.innerHTML = renderMathText(textarea.value || '');
      overlay.scrollTop = textarea.scrollTop;
      overlay.classList.remove('math-overlay--off');
      textarea.classList.add('math-textarea--active');
    }

    textarea.addEventListener('input', update);
    textarea.addEventListener('scroll', function () {
      overlay.scrollTop = textarea.scrollTop;
    });

    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        if (!overlay.classList.contains('math-overlay--off')) {
          overlay.style.width  = textarea.offsetWidth  + 'px';
          overlay.style.height = textarea.offsetHeight + 'px';
        }
      }).observe(textarea);
    }

    textarea._mathOverlayUpdate = update;
  }

  window.MathPreview = {
    attach: attach,
    render: renderMathText,
    refresh: function (ta) {
      if (ta && typeof ta._mathOverlayUpdate === 'function') ta._mathOverlayUpdate();
    }
  };
})();
