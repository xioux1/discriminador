/* ─── SQL Editor ────────────────────────────────────────────────────────────── */
/* Global script — exposes window.SqlEditor                                     */

(function () {
  'use strict';

  var SQL_SUBJECT_RE = /sql|pl[\s\/\-]?sql|base\s+de\s+datos|bd|database|query|labo\s*[0-9]/i;

  var CHECK_CLAUSES = [
    { name: 'SELECT',   re: /\bSELECT\b/i },
    { name: 'FROM',     re: /\bFROM\b/i },
    { name: 'WHERE',    re: /\bWHERE\b/i },
    { name: 'JOIN',     re: /\bJOIN\b/i },
    { name: 'GROUP BY', re: /\bGROUP\s+BY\b/i },
    { name: 'HAVING',   re: /\bHAVING\b/i },
    { name: 'ORDER BY', re: /\bORDER\s+BY\b/i },
    { name: 'LIMIT',    re: /\bLIMIT\b/i },
    { name: 'UNION',    re: /\bUNION\b/i },
    { name: 'WITH/CTE', re: /\bWITH\b/i }
  ];

  var _active      = false;
  var _textarea    = null;
  var _gutter      = null;
  var _tabHandler  = null;
  var _inputHandler  = null;
  var _scrollHandler = null;

  /* ── Tab key: insert 2 spaces ─────────────────────────────────────────────── */
  function onTab(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      var start = e.target.selectionStart;
      var end   = e.target.selectionEnd;
      e.target.value = e.target.value.slice(0, start) + '  ' + e.target.value.slice(end);
      e.target.selectionStart = e.target.selectionEnd = start + 2;
      e.target.dispatchEvent(new Event('input'));
    }
  }

  /* ── Line-number gutter ───────────────────────────────────────────────────── */
  function _buildGutter(textarea) {
    // Wrap textarea in a flex container
    var wrap = document.createElement('div');
    wrap.className = 'sql-editor-wrap';
    textarea.parentNode.insertBefore(wrap, textarea);
    wrap.appendChild(textarea);

    var gutter = document.createElement('div');
    gutter.className = 'sql-line-numbers';
    gutter.setAttribute('aria-hidden', 'true');
    wrap.insertBefore(gutter, textarea);

    return gutter;
  }

  function _updateGutter(gutter, textarea) {
    var count = (textarea.value.match(/\n/g) || []).length + 1;
    var prev  = parseInt(gutter.dataset.lines) || 0;
    if (prev === count) {
      gutter.scrollTop = textarea.scrollTop;
      return;
    }
    gutter.dataset.lines = count;
    var html = '';
    for (var i = 1; i <= count; i++) {
      html += '<span>' + i + '</span>';
    }
    gutter.innerHTML = html;
    gutter.scrollTop = textarea.scrollTop;
  }

  function _removeGutter(textarea) {
    var wrap = textarea.parentNode;
    if (!wrap || !wrap.classList.contains('sql-editor-wrap')) return;
    wrap.parentNode.insertBefore(textarea, wrap);
    wrap.remove();
  }

  /* ── Public API ───────────────────────────────────────────────────────────── */
  function activate(textarea) {
    if (_active && _textarea === textarea) return;
    if (_active) deactivate();
    if (!textarea) return;

    _textarea = textarea;
    _active   = true;

    textarea.classList.add('sql-textarea-active');
    _gutter = _buildGutter(textarea);
    _updateGutter(_gutter, textarea);

    _tabHandler    = onTab;
    _inputHandler  = function () { _updateGutter(_gutter, textarea); };
    _scrollHandler = function () { _gutter.scrollTop = textarea.scrollTop; };

    textarea.addEventListener('keydown', _tabHandler);
    textarea.addEventListener('input',   _inputHandler);
    textarea.addEventListener('scroll',  _scrollHandler);
  }

  function deactivate() {
    if (!_active) return;
    if (_textarea) {
      if (_tabHandler)    _textarea.removeEventListener('keydown', _tabHandler);
      if (_inputHandler)  _textarea.removeEventListener('input',   _inputHandler);
      if (_scrollHandler) _textarea.removeEventListener('scroll',  _scrollHandler);
      _textarea.classList.remove('sql-textarea-active');
      _removeGutter(_textarea);
    }
    _active        = false;
    _textarea      = null;
    _gutter        = null;
    _tabHandler    = null;
    _inputHandler  = null;
    _scrollHandler = null;
  }

  function refresh() {
    // Update gutter if active (e.g. after programmatic value change)
    if (_active && _gutter && _textarea) {
      _gutter.dataset.lines = 0; // force redraw
      _updateGutter(_gutter, _textarea);
    }
  }

  function isActive() { return _active; }

  function matchesSubject(subject) {
    return SQL_SUBJECT_RE.test(subject || '');
  }

  function checkClauses(userSql, expectedSql) {
    var results  = [];
    var user     = userSql || '';
    var expected = expectedSql || '';

    CHECK_CLAUSES.forEach(function (clause) {
      var inExpected = clause.re.test(expected);
      var inUser     = clause.re.test(user);

      if (inExpected && inUser)       results.push({ name: clause.name, status: 'present' });
      else if (inExpected && !inUser) results.push({ name: clause.name, status: 'missing' });
      else if (!inExpected && inUser) results.push({ name: clause.name, status: 'extra' });
    });

    return results;
  }

  window.SqlEditor = {
    activate:       activate,
    deactivate:     deactivate,
    isActive:       isActive,
    matchesSubject: matchesSubject,
    checkClauses:   checkClauses,
    refresh:        refresh
  };
})();
