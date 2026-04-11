/* ─── Math Structured Editor ────────────────────────────────────────────────
   Exposes window.MathPreview.
   When math mode is active, replaces the textarea with a rich contenteditable
   editor that supports structured math input:

     /   →  inserts a fraction  ┌───┐   cursor goes to numerator
                                 │num│
                                 ├───┤   → moves to denominator
                                 │den│
                                 └───┘   → exits the fraction

     ^   →  inserts a superscript box;  → exits it

   Raw text is synced back to the hidden textarea in (num)/(den) / base^exp
   format so the rest of the app works unmodified.                          */

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

  // Is the text cursor at the very end of el's content?
  function atEnd(el) {
    var s = window.getSelection();
    if (!s || !s.rangeCount || !s.isCollapsed) return false;
    var cur = s.getRangeAt(0).cloneRange();
    var end = document.createRange();
    end.selectNodeContents(el);
    end.collapse(false);
    try { return cur.compareBoundaryPoints(Range.END_TO_END, end) >= 0; }
    catch (_) { return false; }
  }

  // Insert `node` at the current cursor position in the active contenteditable.
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

  // Move cursor to just after `mathEl` in its parent.
  function exitAfter(mathEl) {
    var parent = mathEl.parentElement;
    if (!parent) return;
    parent.focus();
    try {
      var r = document.createRange();
      r.setStartAfter(mathEl);
      r.collapse(true);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
    } catch (_) {}
  }

  // Returns the currently-focused .mp-box element, or null.
  function focusedBox() {
    var el = document.activeElement;
    return el && el.classList.contains('mp-box') ? el : null;
  }

  /* ── Element factories ───────────────────────────────────────────────── */

  function makeFrac() {
    var frac = document.createElement('span');
    frac.className = 'mp-frac';
    frac.contentEditable = 'false';   // outer shell: not directly editable
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

  /* ── Arrow-right: exit current box ──────────────────────────────────── */

  function tryExit() {
    var box = focusedBox();
    if (!box || !atEnd(box)) return false;

    var role = box.dataset.boxRole;

    if (role === 'num') {
      // Move to denominator
      var den = box.parentElement &&
                box.parentElement.querySelector('[data-box-role="den"]');
      if (den) { focusStart(den); return true; }
    }

    if (role === 'den') {
      exitAfter(box.parentElement); // exit the whole .mp-frac
      return true;
    }

    if (role === 'sup') {
      exitAfter(box);               // exit the <sup>
      return true;
    }

    return false;
  }

  /* ── Extract raw text from editor DOM ───────────────────────────────── */

  function extractText(el) {
    var out = '';
    el.childNodes.forEach(function (n) {
      if (n.nodeType === 3 /* TEXT_NODE */) {
        out += n.textContent;
      } else if (n.nodeType === 1 /* ELEMENT_NODE */) {
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

  /* ── Main: attach structured editor to a textarea ───────────────────── */

  function attach(textarea, isActiveFn) {
    if (!textarea || textarea._mathEditorAttached) return;
    textarea._mathEditorAttached = true;

    // Build the contenteditable editor — styled to look like the textarea.
    var editor = document.createElement('div');
    editor.className = 'math-ce-editor hidden';
    editor.contentEditable = 'true';
    editor.spellcheck = false;
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    textarea.parentNode.insertBefore(editor, textarea);

    // Sync editor content → textarea value on every change.
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

    // Keyboard handler — fires during CAPTURE so it intercepts keys even when
    // focus is inside an inner .mp-box (nested fraction / superscript).
    editor.addEventListener('keydown', function (e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

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

      if (e.key === 'ArrowRight' && tryExit()) {
        e.preventDefault();
      }
    }, true /* capture */);

    // Show/hide the editor and the textarea based on current mode.
    function update() {
      var active = isActiveFn();
      if (active) {
        // Transfer textarea content to editor (plain text) on first activation.
        if (editor.classList.contains('hidden') && textarea.value.trim() && !editor.textContent.trim()) {
          editor.textContent = textarea.value;
        }
        editor.classList.remove('hidden');
        textarea.style.display = 'none';
      } else {
        sync(); // push final value before hiding
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
