/* ─── Math Structured Editor ────────────────────────────────────────────────
   Exposes window.MathPreview.
   When math mode is active, replaces the textarea with a rich contenteditable
   editor that supports structured math input:

     /      →  inserts a fraction; cursor goes to numerator
     Tab    →  numerator → denominator → exit fraction (always)
     →      →  same as Tab but only at the end of a box
     ^      →  inserts a superscript box
     Tab/→  exits the superscript
     Ctrl+H →  highlight / remove highlight on selection or current block

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
    // sup box is wrapped in a contentEditable="false" span — exit that wrapper.
    if (role === 'sup') { exitAfter(box.parentElement); return true; }

    return false;
  }

  /* ── Highlight helpers ───────────────────────────────────────────────── */

  // Find the nearest .mp-highlight ancestor of the cursor (or null).
  function highlightFromSelection(editor) {
    var sel = window.getSelection();
    var node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    while (node && node !== editor) {
      if (node.nodeType === 1 && node.classList.contains('mp-highlight')) return node;
      node = node.parentNode;
    }
    return null;
  }

  // Apply or remove a highlight on the current selection.
  // - If there is a non-collapsed selection: wrap it in .mp-highlight.
  // - If the cursor sits inside an existing highlight: remove that highlight.
  function applyHighlight(editor) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    var range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;

    // Toggle OFF: cursor or selection inside an existing highlight
    var existing = highlightFromSelection(editor);
    if (existing) {
      var parent = existing.parentNode;
      while (existing.firstChild) parent.insertBefore(existing.firstChild, existing);
      parent.removeChild(existing);
      return;
    }

    // Nothing selected — nothing to do
    if (sel.isCollapsed) return;

    var hl = document.createElement('span');
    hl.className = 'mp-highlight';
    hl.dataset.mathType = 'highlight';

    try {
      range.surroundContents(hl);
    } catch (_) {
      // Selection spans partial element boundaries (e.g. inside a fraction box).
      // Extract what we can and wrap it.
      hl.appendChild(range.extractContents());
      range.insertNode(hl);
    }

    // Collapse cursor to end of highlight
    try {
      var r2 = document.createRange();
      r2.setStartAfter(hl);
      r2.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r2);
    } catch (_) {}
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
    // Wrap in contentEditable="false" so the browser treats it as atomic,
    // just like the fraction wrapper. Without this, the browser doesn't know
    // where the sup ends and keeps the cursor inside it indefinitely.
    var wrapper = document.createElement('span');
    wrapper.contentEditable = 'false';
    wrapper.dataset.mathType = 'sup';

    var sup = document.createElement('sup');
    sup.className = 'mp-box mp-sup-box';
    sup.contentEditable = 'true';
    sup.dataset.boxRole = 'sup';

    wrapper.appendChild(sup);
    return wrapper;
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
        } else if (n.dataset.mathType === 'sup') {
          var supEl = n.querySelector('[data-box-role="sup"]');
          out += '^' + extractText(supEl || n);
        } else if (n.dataset.mathType === 'highlight') {
          out += extractText(n); // visual only — transparent to serialisation
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

  /* ── Box detection via selection (reliable for nested contenteditable) ── */

  function boxFromSelection(editor) {
    var sel = window.getSelection();
    var node = sel && sel.rangeCount ? sel.getRangeAt(0).startContainer : null;
    while (node && node !== editor) {
      if (node.classList && node.classList.contains('mp-box')) return node;
      node = node.parentElement;
    }
    return null;
  }

  /* ── Attach ──────────────────────────────────────────────────────────── */

  function attach(textarea, isActiveFn) {
    if (!textarea || textarea._mathEditorAttached) return;
    textarea._mathEditorAttached = true;

    /* ── Mini toolbar ──────────────────────────────────────────────────── */
    var toolbar = document.createElement('div');
    toolbar.className = 'math-mini-toolbar hidden';

    var hlBtn = document.createElement('button');
    hlBtn.type = 'button';
    hlBtn.className = 'math-toolbar-btn';
    hlBtn.title = 'Resaltar selección (Ctrl+H)';
    hlBtn.innerHTML = '<span class="math-toolbar-btn-icon"></span>Resaltar';
    toolbar.appendChild(hlBtn);
    textarea.parentNode.insertBefore(toolbar, textarea);

    // Keep highlight button state in sync with cursor position
    function updateHlBtn() {
      var inHl = !!highlightFromSelection(editor);
      hlBtn.classList.toggle('math-toolbar-btn--active', inHl);
    }

    hlBtn.addEventListener('mousedown', function (e) {
      e.preventDefault(); // don't steal focus from editor
      applyHighlight(editor);
      updateHlBtn();
      sync();
    });

    /* ── Editor ─────────────────────────────────────────────────────────── */
    var editor = document.createElement('div');
    editor.className = 'math-ce-editor hidden';
    editor.contentEditable = 'true';
    editor.spellcheck = false;
    editor.setAttribute('role', 'textbox');
    editor.setAttribute('aria-multiline', 'true');
    textarea.parentNode.insertBefore(editor, textarea);

    editor.addEventListener('keyup', updateHlBtn);
    editor.addEventListener('mouseup', updateHlBtn);

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
      // Ctrl+H / Cmd+H — toggle highlight on selection
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === 'h') {
        e.preventDefault();
        applyHighlight(editor);
        updateHlBtn();
        sync();
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return;

      // Walk from cursor position up to find the nearest .mp-box ancestor.
      // This is reliable even for nested contenteditable (unlike e.target).
      var box = boxFromSelection(editor);

      // Enter: insert <br> instead of letting the browser split the div,
      // which would drag math elements to the new block.
      if (e.key === 'Enter') {
        e.preventDefault();
        var br = document.createElement('br');
        insertAtCursor(br);
        // Ensure there's a text node after the <br> so the cursor lands there.
        var sel = window.getSelection();
        var r2 = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
        if (r2) {
          var afterBr = r2.startContainer;
          // If we're at the end of a text node or the container has nothing
          // after the <br>, insert a zero-width space so the cursor is visible.
          if (r2.startContainer === br.parentNode &&
              r2.startContainer.childNodes[r2.startOffset] === undefined) {
            var zws = document.createTextNode('\u200B');
            r2.startContainer.appendChild(zws);
            r2.setStart(zws, 1);
            r2.collapse(true);
            sel.removeAllRanges();
            sel.addRange(r2);
          }
        }
        sync();
        return;
      }

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
        var supWrapper = makeSup();
        insertAtCursor(supWrapper);
        focusStart(supWrapper.querySelector('[data-box-role="sup"]'));
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

      // Backspace inside an empty box: remove the whole math element and
      // place cursor before where it was. This lets the user delete a
      // fraction or superscript they no longer want.
      if (e.key === 'Backspace' && box && box.textContent.replace(/\u200B/g, '') === '') {
        e.preventDefault();
        // The math element is either .mp-frac or the contentEditable=false wrapper
        var mathEl = box.parentElement;
        var parent = mathEl && mathEl.parentElement;
        if (!parent) return;

        // Place cursor at the text node just before mathEl, or create one.
        var prev = mathEl.previousSibling;
        var anchor, anchorOffset;
        if (prev && prev.nodeType === 3) {
          anchor = prev;
          anchorOffset = prev.length;
        } else {
          anchor = document.createTextNode('\u200B');
          parent.insertBefore(anchor, mathEl);
          anchorOffset = 1;
        }

        parent.removeChild(mathEl);
        parent.focus();
        try {
          var r = document.createRange();
          r.setStart(anchor, anchorOffset);
          r.collapse(true);
          var s = window.getSelection();
          s.removeAllRanges();
          s.addRange(r);
        } catch (_) {}
        sync();
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
        toolbar.classList.remove('hidden');
        textarea.style.display = 'none';
      } else {
        sync();
        editor.classList.add('hidden');
        toolbar.classList.add('hidden');
        textarea.style.display = '';
      }
    }

    textarea._mathEditorUpdate = update;
    textarea._mathEditorEl = editor;
    update();
  }

  window.MathPreview = {
    attach: attach,
    refresh: function (ta) {
      if (ta && typeof ta._mathEditorUpdate === 'function') ta._mathEditorUpdate();
    },
    // Clear both the textarea value and the contenteditable editor content.
    clear: function (ta) {
      if (!ta) return;
      ta.value = '';
      if (ta._mathEditorEl) ta._mathEditorEl.innerHTML = '';
    }
  };
})();
