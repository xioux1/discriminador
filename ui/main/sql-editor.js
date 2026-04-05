/* ─── SQL Editor ────────────────────────────────────────────────────────────── */
/* Global script — exposes window.SqlEditor                                     */

(function () {
  'use strict';

  var SQL_SUBJECT_RE = /sql|base\s+de\s+datos|bd|database|query/i;

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

  var _active = false;
  var _textarea = null;
  var _tabHandler = null;

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

  function activate(textarea) {
    if (_active && _textarea === textarea) return;
    if (_active) deactivate();
    if (!textarea) return;

    _textarea = textarea;
    _active = true;
    _tabHandler = onTab;
    textarea.addEventListener('keydown', _tabHandler);
    textarea.classList.add('sql-textarea-active');
  }

  function deactivate() {
    if (!_active) return;
    if (_textarea && _tabHandler) {
      _textarea.removeEventListener('keydown', _tabHandler);
      _textarea.classList.remove('sql-textarea-active');
    }
    _active = false;
    _textarea = null;
    _tabHandler = null;
  }

  function isActive() { return _active; }

  function matchesSubject(subject) {
    return SQL_SUBJECT_RE.test(subject || '');
  }

  // No-op kept for compatibility (overlay removed)
  function refresh() {}

  function checkClauses(userSql, expectedSql) {
    var results = [];
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
