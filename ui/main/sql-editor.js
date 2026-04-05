/* ─── SQL Editor ────────────────────────────────────────────────────────────── */
/* Global script — exposes window.SqlEditor                                     */

(function () {
  'use strict';

  var _active = false;
  var _wrapper = null;
  var _highlightLayer = null;
  var _textarea = null;
  var _originalParent = null;
  var _originalNextSibling = null;
  var _savedStyle = {};

  var SQL_SUBJECT_RE = /sql|base\s+de\s+datos|bd|database|query/i;

  // Keywords ordered longest-first to avoid partial matches (e.g. IS NULL before IS)
  var KEYWORDS = [
    'IS NOT NULL',
    'IS NULL',
    'GROUP BY',
    'ORDER BY',
    'PRIMARY KEY',
    'FOREIGN KEY',
    'INSERT INTO',
    'CREATE TABLE',
    'LEFT JOIN',
    'RIGHT JOIN',
    'INNER JOIN',
    'CROSS JOIN',
    'NOT IN',
    'COALESCE',
    'DISTINCT',
    'INTERSECT',
    'RETURNING',
    'REFERENCES',
    'BETWEEN',
    'HAVING',
    'EXISTS',
    'SELECT',
    'INSERT',
    'DELETE',
    'UPDATE',
    'CREATE',
    'VALUES',
    'EXCEPT',
    'OFFSET',
    'UNION',
    'WHERE',
    'ALTER',
    'TABLE',
    'LIMIT',
    'COUNT',
    'CASE',
    'WHEN',
    'THEN',
    'ELSE',
    'WITH',
    'FROM',
    'INTO',
    'JOIN',
    'DROP',
    'SET',
    'AND',
    'NOT',
    'END',
    'AVG',
    'MAX',
    'MIN',
    'SUM',
    'AS',
    'ON',
    'OR',
    'IN',
    'IS',
    'LIKE',
    'NULL'
  ];

  // Clauses for checkClauses()
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

  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function highlightSql(text) {
    // Build a single regex that matches (in order):
    //   1. single-quoted strings  '...'  (with escaped quotes '')
    //   2. line comments          -- ...
    //   3. each keyword (word-boundary, case-insensitive)
    // Everything else is plain text that gets HTML-escaped.

    // Build keyword alternation — already ordered longest-first
    var kwParts = KEYWORDS.map(function (kw) {
      // Escape special regex chars (space → \s+ for multi-word keywords)
      var escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      return escaped;
    });

    var pattern = /'(?:[^'\\]|''|\\.)*'|--[^\n]*|(?:' + kwParts.join('|') + ')(?=[^a-zA-Z0-9_]|$)/gi;

    // We build the pattern as a string to embed the dynamic keywords
    var patternStr = "'(?:[^'\\\\]|''|\\\\.)*'|--[^\\n]*|\\b(?:" + kwParts.join('|') + ')\\b';
    var re = new RegExp(patternStr, 'gi');

    var result = '';
    var lastIndex = 0;
    var match;

    while ((match = re.exec(text)) !== null) {
      // Append plain text before this match (HTML-escaped)
      if (match.index > lastIndex) {
        result += escapeHtml(text.slice(lastIndex, match.index));
      }

      var token = match[0];
      if (token.charAt(0) === "'") {
        result += '<span class="sql-str">' + escapeHtml(token) + '</span>';
      } else if (token.slice(0, 2) === '--') {
        result += '<span class="sql-comment">' + escapeHtml(token) + '</span>';
      } else {
        // keyword — preserve original casing
        result += '<span class="sql-kw">' + escapeHtml(token) + '</span>';
      }

      lastIndex = match.index + token.length;
    }

    // Append any remaining plain text
    if (lastIndex < text.length) {
      result += escapeHtml(text.slice(lastIndex));
    }

    // Preserve newlines and trailing newline (textarea adds one when text ends with \n)
    result = result.replace(/\n/g, '<br>');
    if (text.endsWith('\n')) {
      result += '<br>';
    }

    return result;
  }

  function syncScroll() {
    if (_highlightLayer && _textarea) {
      _highlightLayer.scrollTop  = _textarea.scrollTop;
      _highlightLayer.scrollLeft = _textarea.scrollLeft;
    }
  }

  function onInput() {
    if (_highlightLayer && _textarea) {
      _highlightLayer.innerHTML = highlightSql(_textarea.value);
      syncScroll();
    }
  }

  function activate(textarea) {
    if (_active && _textarea === textarea) return;
    if (_active) deactivate();
    if (!textarea) return;

    _textarea = textarea;
    _active = true;

    // Save original parent position so we can restore
    _originalParent = textarea.parentNode;
    _originalNextSibling = textarea.nextSibling;

    // Save original inline styles we'll override
    _savedStyle = {
      color:      textarea.style.color,
      background: textarea.style.background,
      position:   textarea.style.position,
      zIndex:     textarea.style.zIndex,
      caretColor: textarea.style.caretColor
    };

    // Create wrapper
    _wrapper = document.createElement('div');
    _wrapper.className = 'sql-editor-wrapper';

    // Insert wrapper where textarea currently is
    _originalParent.insertBefore(_wrapper, textarea);

    // Create highlight layer
    _highlightLayer = document.createElement('div');
    _highlightLayer.className = 'sql-highlight-layer';
    _highlightLayer.setAttribute('aria-hidden', 'true');

    // Append both to wrapper (layer first so it's behind)
    _wrapper.appendChild(_highlightLayer);
    _wrapper.appendChild(textarea);

    // Style the textarea so layer shows through
    textarea.style.color      = 'transparent';
    textarea.style.caretColor = 'var(--text, #1a1a2e)';
    textarea.style.background = 'transparent';
    textarea.style.position   = 'relative';
    textarea.style.zIndex     = '1';

    // Tab key → insert 2 spaces instead of jumping focus
    function onTab(e) {
      if (e.key === 'Tab') {
        e.preventDefault();
        var start = textarea.selectionStart;
        var end   = textarea.selectionEnd;
        textarea.value = textarea.value.slice(0, start) + '  ' + textarea.value.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        textarea.dispatchEvent(new Event('input'));
      }
    }
    textarea._sqlTabHandler = onTab;

    // Attach listeners
    textarea.addEventListener('keydown', onTab);
    textarea.addEventListener('input', onInput);
    textarea.addEventListener('scroll', syncScroll);

    // Initial render
    onInput();
  }

  function deactivate() {
    if (!_active) return;
    _active = false;

    var ta = _textarea;

    // Restore textarea styles
    if (ta) {
      ta.style.color      = _savedStyle.color;
      ta.style.background = _savedStyle.background;
      ta.style.position   = _savedStyle.position;
      ta.style.zIndex     = _savedStyle.zIndex;
      ta.style.caretColor = _savedStyle.caretColor;

      if (ta._sqlTabHandler) {
        ta.removeEventListener('keydown', ta._sqlTabHandler);
        delete ta._sqlTabHandler;
      }
      ta.removeEventListener('input', onInput);
      ta.removeEventListener('scroll', syncScroll);
    }

    // Move textarea back to original location and remove wrapper
    if (_wrapper && _originalParent) {
      if (_originalNextSibling && _originalNextSibling.parentNode === _originalParent) {
        _originalParent.insertBefore(ta, _originalNextSibling);
      } else {
        _originalParent.appendChild(ta);
      }
      if (_wrapper.parentNode) {
        _wrapper.parentNode.removeChild(_wrapper);
      }
    }

    _wrapper = null;
    _highlightLayer = null;
    _textarea = null;
    _originalParent = null;
    _originalNextSibling = null;
    _savedStyle = {};
  }

  function isActive() {
    return _active;
  }

  function matchesSubject(subject) {
    return SQL_SUBJECT_RE.test(subject || '');
  }

  function checkClauses(userSql, expectedSql) {
    var results = [];
    var user = userSql || '';
    var expected = expectedSql || '';

    CHECK_CLAUSES.forEach(function (clause) {
      var inExpected = clause.re.test(expected);
      var inUser = clause.re.test(user);

      var status;
      if (inExpected && inUser) {
        status = 'present';
      } else if (inExpected && !inUser) {
        status = 'missing';
      } else if (!inExpected && inUser) {
        status = 'extra';
      } else {
        // neither in expected nor in user — not relevant, skip
        return;
      }

      results.push({ name: clause.name, status: status });
    });

    return results;
  }

  // Force re-render the highlight layer (call after programmatically clearing the textarea)
  function refresh() {
    if (_active && _highlightLayer && _textarea) {
      _highlightLayer.innerHTML = highlightSql(_textarea.value);
    }
  }

  window.SqlEditor = {
    activate: activate,
    deactivate: deactivate,
    isActive: isActive,
    matchesSubject: matchesSubject,
    checkClauses: checkClauses,
    refresh: refresh,
    _highlightSql: highlightSql
  };
})();
