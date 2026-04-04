/* ─── Math Symbol Palette ───────────────────────────────────────────────────── */
/* Global script — exposes window.MathPalette                                   */

(function () {
  'use strict';

  var _initialized = false;
  var _panel = null;
  var _trigger = null;
  var _activeTextarea = null;
  var _visible = false;

  var SYMBOL_GROUPS = [
    {
      label: 'Básico',
      symbols: ['²', '³', '√', '±', '×', '÷', '≠', '≤', '≥', '≈', '∞']
    },
    {
      label: 'Griego',
      symbols: ['α', 'β', 'γ', 'δ', 'ε', 'θ', 'λ', 'μ', 'π', 'σ', 'φ', 'ω', 'Δ', 'Σ', 'Ω']
    },
    {
      label: 'Fracciones',
      symbols: ['½', '⅓', '¼', '⅔', '¾']
    },
    {
      label: 'Cálculo',
      symbols: ['∫', '∬', '∂', '∇', '∑', '∏', 'lim', 'dx', 'dy', 'dz']
    },
    {
      label: 'Lógica',
      symbols: ['∀', '∃', '∈', '∉', '⊂', '⊃', '∪', '∩', '¬', '∧', '∨', '⇒', '⇔']
    }
  ];

  var MATH_SUBJECT_RE = /mat|f[íi]sica|c[áa]lc|[áa]lgebra|geometr[íi]a|estad[íi]stica|qu[íi]m/i;

  function matchesSubject(subject) {
    return MATH_SUBJECT_RE.test(subject || '');
  }

  function insertSymbol(symbol) {
    var ta = _activeTextarea;
    if (!ta) return;

    var start = ta.selectionStart;
    var end = ta.selectionEnd;
    var value = ta.value;

    ta.value = value.slice(0, start) + symbol + value.slice(end);
    var newPos = start + symbol.length;
    ta.focus();
    ta.setSelectionRange(newPos, newPos);

    // Trigger input event so any listeners (e.g. SQL highlight) update
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function buildPanel() {
    var panel = document.createElement('div');
    panel.className = 'math-palette-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Paleta de símbolos matemáticos');

    var header = document.createElement('div');
    header.className = 'math-palette-header';

    var title = document.createElement('span');
    title.className = 'math-palette-title';
    title.textContent = 'Símbolos';

    var closeBtn = document.createElement('button');
    closeBtn.className = 'math-palette-close';
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Cerrar paleta');
    closeBtn.textContent = '✕';
    closeBtn.addEventListener('click', function () {
      hidePanel();
    });

    header.appendChild(title);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    SYMBOL_GROUPS.forEach(function (group) {
      var groupEl = document.createElement('div');
      groupEl.className = 'math-palette-group';

      var labelEl = document.createElement('div');
      labelEl.className = 'math-palette-group-label';
      labelEl.textContent = group.label;
      groupEl.appendChild(labelEl);

      var grid = document.createElement('div');
      grid.className = 'math-palette-grid';

      group.symbols.forEach(function (sym) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'math-palette-sym';
        btn.textContent = sym;
        btn.title = sym;
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          insertSymbol(sym);
        });
        grid.appendChild(btn);
      });

      groupEl.appendChild(grid);
      panel.appendChild(groupEl);
    });

    return panel;
  }

  function showPanel() {
    if (_visible) return;
    _visible = true;
    _panel.classList.add('math-palette-panel--open');
    _trigger.setAttribute('aria-expanded', 'true');
  }

  function hidePanel() {
    if (!_visible) return;
    _visible = false;
    _panel.classList.remove('math-palette-panel--open');
    _trigger.setAttribute('aria-expanded', 'false');
  }

  function togglePanel() {
    if (_visible) {
      hidePanel();
    } else {
      showPanel();
    }
  }

  function init() {
    if (_initialized) return;
    _initialized = true;

    // Build trigger FAB button
    _trigger = document.createElement('button');
    _trigger.type = 'button';
    _trigger.className = 'math-palette-trigger hidden';
    _trigger.setAttribute('aria-haspopup', 'dialog');
    _trigger.setAttribute('aria-expanded', 'false');
    _trigger.innerHTML = '&sum; Símbolos';
    _trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      togglePanel();
    });
    document.body.appendChild(_trigger);

    // Build panel
    _panel = buildPanel();
    document.body.appendChild(_panel);

    // Close on outside click
    document.addEventListener('click', function (e) {
      if (_visible && !_panel.contains(e.target) && e.target !== _trigger) {
        hidePanel();
      }
    });

    // Close on Escape
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _visible) {
        hidePanel();
      }
    });
  }

  function setActiveTextarea(el) {
    _activeTextarea = el;
  }

  function updateSubject(subject) {
    if (!_trigger) return;
    if (matchesSubject(subject)) {
      _trigger.classList.remove('hidden');
    } else {
      _trigger.classList.add('hidden');
      hidePanel();
    }
  }

  window.MathPalette = {
    init: init,
    setActiveTextarea: setActiveTextarea,
    updateSubject: updateSubject
  };
})();
