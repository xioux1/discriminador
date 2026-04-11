/* ─── Math Structured Editor ────────────────────────────────────────────────
   Exposes window.MathPreview.
   When math mode is active, replaces the textarea with a rich contenteditable
   editor that supports structured math input:

     /    →  inserts a fraction; cursor goes to numerator
     Tab  →  numerator → denominator → exit fraction (always)
     →    →  same as Tab but only at the end of a box
     ^    →  inserts a superscript box
     Tab/→  exits the superscript

   Raw text is synced to the hidden textarea in (num)/(den) / base^exp format.
*/

(function () {
  'use strict';

  /* ── Cursor helpers ──────────────────────────────────────────────────── */

  function focusStart(el) {
    el.focus();
    try {
      var r = document.createRange();
      r.selectNodeContents(el);
      r.collapse(true);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } catch (_) {}
  }

  // Is the cursor at the very end of el?
  // Uses e.target (the actual focused element) for the check.
  function atEnd(el) {
    var s = window.getSelection();
    if (!s || !s.rangeCount || !s.isCollapsed) return false;
    var r = s.getRangeAt(0);
    if (!el.contains(r.startContainer)) return false;
    try {
      var beforeCursor = document.createRange();
      beforeCursor.selectNodeContents(el);
      beforeCursor.setEnd(r.startContainer, r.startOffset);
      return beforeCursor.toString().length >= el.textContent.length;
    } catch (_) {
      return el.textContent.length === 0;
    }
  }

  // Insert `node` at the current selection point.
  function insertAtCursor(node) {
    var s = window.getSelection();
    if (!s || !s.rangeCount) return;
    var r = s.getRangeAt(0);
    r.deleteContents();
    r.insertNode(node);
    r.setStartAfter(node);
    r.setEndAfter(node);
    s.removeAllRanges();
    s.addRange(r);
  }

  // Move cursor to just after `mathEl`, creating a text anchor if needed.
  function exitAfter(mathEl) {
    var parent = mathEl.parentElement;
    if (!parent) return;

    // We need a real text node to place the cursor in — otherwise some
    // browsers refuse to place the caret after a contentEditable="false" node.
    var next = mathEl.nextSibling;
    var anchor, anchorOffset;

    if (next && next.nodeType === 3 /* TEXT_NODE */) {
      anchor = next;
      anchorOffset = 0;                 // right at the start of existing text
    } else {
      anchor = document.createTextNode('\u200B'); // zero-width space as anchor
      parent.insertBefore(anchor, next || null);
      anchorOffset = 1;                 // after the zero-width space
    }

    parent.focus();
    try {
      var r = document.createRange();
      r.setStart(anchor, anchorOffset);
      r.collapse(true);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } catch (_) {}
  }

  /* ── Navigation: handle a box key (Tab always, Arrow only at end) ──── */

  // `always`: true for Tab (navigate regardless of cursor position),
  //            false for ArrowRight (only navigate at end of box).
  // Returns true if navigation happened (caller should preventDefault).
  function handleBoxNav(box, always) {
    if (!always && !atEnd(box)) return false;

    var role = box.dataset.boxRole;

    if (role === 'num') {
      var den = box.parentElement &&
                box.parentElement.querySelector('[data-box-role="den"]');
      if (den) { focusStart(den); return true; }
    }

    if (role === 'den') { exitAfter(box.parentElement); return true; }
    if (role === 'sup') { exitAfter(box); return true; }

    return false;
  }

  /* ── Element factories ───────────────────────────────────────────────── */

  function makeFrac() {
    var frac = document.createElement('span');
    frac.className = 'mp-frac';
    frac.contentEditable = 'false';
    frac.dataset.mathType = 'frac';

    var num = document.createElement('span');
    num.className = 'mp-num mp-box';
    num.contentEditable = 'true';
    num.dataset.boxRole = 'num';

    var den = document.createElement('span');
    den.className = 'mp-den mp-box';
    den.contentEditable = 'true';
    den.dataset.boxRole = 'den';

    frac.appendChild(num);
    frac.appendChild(den);
    return frac;
  }

  function makeSup() {
    var sup = document.createElement('sup');
    sup.className = 'mp-box mp-sup-box';
    sup.contentEditable = 'true';
    sup.dataset.boxRole = 'sup';
    return sup;
  }

  /* ── Text extraction ──────────────────────────────────────────────────── */

  function extractText(el) {
    var out = '';
    el.childNodes.forEach(function (n) {
      if (n.nodeType === 3) {
        out += n.textContent.replace(/\u200B/g, ''); // strip cursor anchors
      } else if (n.nodeType === 1) {
        var tag = n.tagName.toLowerCase();
        if (n.dataset.mathType === 'frac') {
          var numEl = n.querySelector('[data-box-role="num"]');
          var denEl = n.querySelector('[data-box-role="den"]');
          out += '(' + extractText(numEl || n) + ')/(' + extractText(denEl || n) + ')';
        } else if (tag === 'sup' && n.classList.contains('mp-box')) {
          out += '^' + extractText(n);
        } else if (tag === 'br') {
          out += '\n';
        } else if (tag === 'div') {
          out += '\n' + extractText(n);
        } else {
          out += extractText(n);
        }
      }
    });
    return out;
  }

  /* ── Attach ──────────────────────────────────────────────────────────── */

  function attach(textarea, isActiveFn) {
    if (!textarea || textarea._mathEditorAttached) return;
    textarea._mathEditorAttached = true;

    var editor = document.createElement('div');
    editor.className = 'math-ce-editor hidden';
    editor.contentEditable = 'true';
    editor.spellcheck = false;
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    textarea.parentNode.insertBefore(editor, textarea);

    var _syncing = false;
    function sync() {
      if (_syncing) return;
      var text = extractText(editor);
      if (textarea.value !== text) {
        textarea.value = text;
        _syncing = true;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        _syncing = false;
      }
    }

    editor.addEventListener('input', sync);

    // capture:true so this fires even when an inner .mp-box has focus.
    editor.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Use e.target — reliable even with nested contenteditable.
      var box = e.target.classList && e.target.classList.contains('mp-box')
                ? e.target : null;

      if (e.key === '/') {
        e.preventDefault();
        var frac = makeFrac();
        insertAtCursor(frac);
        focusStart(frac.querySelector('[data-box-role="num"]'));
        sync();
        return;
      }

      if (e.key === '^') {
        e.preventDefault();
        var sup = makeSup();
        insertAtCursor(sup);
        focusStart(sup);
        sync();
        return;
      }

      // Tab inside a math box: always navigate to next section.
      if (e.key === 'Tab' && box) {
        if (handleBoxNav(box, true)) {
          e.preventDefault();
        }
        return;
      }

      // ArrowRight inside a math box: navigate only when at the end.
      if (e.key === 'ArrowRight' && box) {
        if (handleBoxNav(box, false)) {
          e.preventDefault();
        }
        return;
      }
    }, true /* capture */);

    function update() {
      var active = isActiveFn();
      if (active) {
        if (editor.classList.contains('hidden') && textarea.value.trim() && !editor.textContent.trim()) {
          editor.textContent = textarea.value;
        }
        editor.classList.remove('hidden');
        textarea.style.display = 'none';
      } else {
        sync();
        editor.classList.add('hidden');
        textarea.style.display = '';
      }
    }

    textarea._mathEditorUpdate = update;
    update();
  }

  window.MathPreview = {
    attach: attach,
    refresh: function (ta) {
      if (ta && typeof ta._mathEditorUpdate === 'function') ta._mathEditorUpdate();
    }
  };
})();
