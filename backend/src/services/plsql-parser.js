/**
 * Minimal structural PL/SQL parser for Oracle syntax validation.
 *
 * Replaces regex-based keyword counting with a proper tokenizer + block stack,
 * which correctly handles structures like IF/ELSIF/ELSE/END IF (where the old
 * approach counted the IF inside "END IF" as an extra block opener).
 *
 * Covered blocks:
 *   IF … END IF          (ELSIF / ELSE are not block openers)
 *   FOR/WHILE/bare LOOP … END LOOP
 *   CASE … END CASE      (PL/SQL statement style)
 *   BEGIN … END          (anonymous block or procedure/function/package body)
 *
 * Conservative approach: prefers false negatives over false positives.
 * SQL CASE expressions (ending with bare END, not END CASE) are handled
 * transparently via the bare-END/CASE-pop rule.
 */

'use strict';

// ─── Keywords recognised by the tokeniser ────────────────────────────────────
const KEYWORD_SET = new Set([
  'IF', 'ELSIF', 'ELSE', 'THEN', 'END',
  'FOR', 'WHILE', 'LOOP', 'IN',
  'CASE', 'WHEN',
  'BEGIN', 'DECLARE', 'EXCEPTION',
  'RETURN', 'IS', 'AS', 'BY',
  'CREATE', 'OR', 'REPLACE',
  'PROCEDURE', 'FUNCTION', 'PACKAGE', 'TRIGGER', 'BODY',
  'CURSOR', 'NULL', 'SELECT', 'FROM', 'WHERE',
  'INSERT', 'UPDATE', 'DELETE', 'INTO',
  'SET', 'VALUES', 'COMMIT', 'ROLLBACK',
  'EXIT', 'RAISE',
]);

// ─── Tokeniser ────────────────────────────────────────────────────────────────

/**
 * Converts a PL/SQL string into a flat array of tokens.
 * Handles: single-line comments (--), block comments (/* … * /),
 * string literals ('…' with '' escape), identifiers/keywords, semicolons.
 *
 * @param {string} sql
 * @returns {{ type: string, value: string, line: number }[]}
 */
function tokenize(sql) {
  const tokens = [];
  let i = 0;
  let line = 1;
  const len = sql.length;

  while (i < len) {
    const ch = sql[i];

    // ── Newline ───────────────────────────────────────────────────────────────
    if (ch === '\n') { line++; i++; continue; }

    // ── Other whitespace ──────────────────────────────────────────────────────
    if (ch === '\r' || ch === '\t' || ch === ' ') { i++; continue; }

    // ── Single-line comment: -- to end of line ────────────────────────────────
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n') i++;
      continue;
    }

    // ── Multi-line comment: /* … */ ───────────────────────────────────────────
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < len) {
        if (sql[i] === '\n') line++;
        if (sql[i] === '*' && sql[i + 1] === '/') { i += 2; break; }
        i++;
      }
      continue;
    }

    // ── String literal: '…' with '' as escape ────────────────────────────────
    if (ch === "'") {
      const startLine = line;
      i++;
      while (i < len) {
        if (sql[i] === "'") {
          i++;
          if (i < len && sql[i] === "'") { i++; continue; } // '' → escaped quote
          break;
        }
        if (sql[i] === '\n') line++;
        i++;
      }
      tokens.push({ type: 'STRING', value: "'...'", line: startLine });
      continue;
    }

    // ── Semicolon ─────────────────────────────────────────────────────────────
    if (ch === ';') {
      tokens.push({ type: 'PUNCT', value: ';', line });
      i++;
      continue;
    }

    // ── Other punctuation / operators (consume silently) ──────────────────────
    if ('(),.:=%<>!+-*/|^&@'.includes(ch)) { i++; continue; }

    // ── Number ────────────────────────────────────────────────────────────────
    if (ch >= '0' && ch <= '9') {
      while (i < len && ((sql[i] >= '0' && sql[i] <= '9') || sql[i] === '.' || sql[i] === '_')) i++;
      continue;
    }

    // ── Identifier or keyword ─────────────────────────────────────────────────
    if (/[a-zA-Z_#$]/.test(ch)) {
      const startLine = line;
      const start = i;
      while (i < len && /[a-zA-Z0-9_#$]/.test(sql[i])) i++;
      const word = sql.slice(start, i).toUpperCase();
      // NULLIF, COALESCE, etc. must remain IDENTIFIER so they don't trigger
      // the IF / LOOP / CASE block-tracking logic.
      const type = KEYWORD_SET.has(word) ? 'KEYWORD' : 'IDENTIFIER';
      tokens.push({ type, value: word, line: startLine });
      continue;
    }

    // ── Anything else — consume silently ──────────────────────────────────────
    i++;
  }

  return tokens;
}

// ─── Block tracker ────────────────────────────────────────────────────────────

/**
 * Walks the token stream and tracks nested block openers/closers.
 * Returns an array of error objects { line, message, hint? }.
 *
 * @param {string} sql
 * @returns {{ line: number, message: string, hint?: string }[]}
 */
function validate(sql) {
  const tokens = tokenize(sql);
  const errors = [];
  const stack  = []; // { type: 'IF'|'LOOP'|'CASE'|'BEGIN', line: number }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Assert that tokens[idx] is a semicolon; add error otherwise. */
  function expectSemicolon(idx, keyword, line) {
    const tok = tokens[idx];
    if (!tok || tok.value !== ';') {
      errors.push({
        line,
        message: `PLS-00103: Falta ';' después de ${keyword}`,
        hint:    `${keyword} debe terminar con ;`,
      });
    }
  }

  /**
   * Pop the topmost block of `expectedType` from the stack.
   * If none is found, push an "unmatched closer" error.
   */
  function closeBlock(expectedType, line, keyword) {
    for (let j = stack.length - 1; j >= 0; j--) {
      if (stack[j].type === expectedType) {
        stack.splice(j, 1);
        return;
      }
    }
    errors.push({
      line,
      message: `PLS-00103: ${keyword} sin ${expectedType} correspondiente`,
      hint:    `${keyword} no tiene un bloque de apertura que coincida`,
    });
  }

  // ── Main pass ──────────────────────────────────────────────────────────────

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    // Only keywords drive block tracking
    if (tok.type !== 'KEYWORD' && tok.type !== 'IDENTIFIER') continue;

    const val = tok.value;

    // ── Block openers ──────────────────────────────────────────────────────

    if (val === 'BEGIN') {
      stack.push({ type: 'BEGIN', line: tok.line });
      continue;
    }

    if (val === 'IF') {
      // ELSIF produces a single KEYWORD token 'ELSIF', so it never reaches here.
      // The IF inside END IF is consumed before the outer loop sees it (see END handler).
      stack.push({ type: 'IF', line: tok.line });
      continue;
    }

    if (val === 'LOOP') {
      // Covers: FOR … LOOP, WHILE … LOOP, bare LOOP.
      // LOOP itself is the block opener in all three forms.
      stack.push({ type: 'LOOP', line: tok.line });
      continue;
    }

    if (val === 'CASE') {
      // Covers both PL/SQL CASE statements (END CASE) and SQL CASE expressions
      // (bare END). The bare-END handler pops a CASE from the stack transparently.
      stack.push({ type: 'CASE', line: tok.line });
      continue;
    }

    // ── Block closers ──────────────────────────────────────────────────────

    if (val === 'END') {
      const next    = tokens[i + 1];
      const nextVal = (next?.type === 'KEYWORD') ? next.value : null;

      // END IF
      if (nextVal === 'IF') {
        i++; // consume the IF token so it won't be seen as a standalone opener
        closeBlock('IF', tok.line, 'END IF');
        expectSemicolon(i + 1, 'END IF', tok.line);
        continue;
      }

      // END LOOP
      if (nextVal === 'LOOP') {
        i++;
        closeBlock('LOOP', tok.line, 'END LOOP');
        expectSemicolon(i + 1, 'END LOOP', tok.line);
        continue;
      }

      // END CASE
      if (nextVal === 'CASE') {
        i++;
        closeBlock('CASE', tok.line, 'END CASE');
        expectSemicolon(i + 1, 'END CASE', tok.line);
        continue;
      }

      // END name  (e.g. END my_proc; or END pkg_body;)
      if (next?.type === 'IDENTIFIER') {
        i++; // consume the name token
        if (stack.length === 0) {
          errors.push({ line: tok.line, message: `PLS-00103: END ${next.value} sin bloque correspondiente` });
        } else {
          const top = stack[stack.length - 1];
          if (top.type === 'IF') {
            errors.push({ line: tok.line, message: `PLS-00103: Usá END IF; para cerrar el IF de la línea ${top.line}`, hint: 'END IF;' });
          } else if (top.type === 'LOOP') {
            errors.push({ line: tok.line, message: `PLS-00103: Usá END LOOP; para cerrar el LOOP de la línea ${top.line}`, hint: 'END LOOP;' });
          } else {
            stack.pop(); // BEGIN or CASE (sql expr)
          }
        }
        expectSemicolon(i + 1, `END ${next.value}`, tok.line);
        continue;
      }

      // Bare END (followed by ; or end of input)
      // ─ closes a BEGIN block, or a SQL-style CASE expression.
      if (stack.length === 0) {
        errors.push({ line: tok.line, message: `PLS-00103: END sin bloque correspondiente`, hint: 'Hay un END de más' });
      } else {
        const top = stack[stack.length - 1];
        if (top.type === 'IF') {
          errors.push({ line: tok.line, message: `PLS-00103: Usá END IF; para cerrar el IF de la línea ${top.line}`, hint: 'END IF;' });
        } else if (top.type === 'LOOP') {
          errors.push({ line: tok.line, message: `PLS-00103: Usá END LOOP; para cerrar el LOOP de la línea ${top.line}`, hint: 'END LOOP;' });
        } else {
          stack.pop(); // BEGIN → block end; CASE → SQL CASE expression end
        }
      }
      expectSemicolon(i + 1, 'END', tok.line);
    }
  }

  // ── Unclosed blocks ────────────────────────────────────────────────────────
  for (const block of stack) {
    if (block.type === 'IF') {
      errors.push({
        line: block.line,
        message: `PLS-00103: IF sin END IF correspondiente (abierto en línea ${block.line})`,
        hint:    'Cada IF...THEN necesita un END IF;',
      });
    } else if (block.type === 'LOOP') {
      errors.push({
        line: block.line,
        message: `PLS-00103: LOOP sin END LOOP correspondiente (abierto en línea ${block.line})`,
        hint:    'Cada LOOP necesita un END LOOP;',
      });
    } else if (block.type === 'BEGIN') {
      errors.push({
        line: block.line,
        message: `PLS-00103: BEGIN sin END correspondiente (abierto en línea ${block.line})`,
        hint:    'Cada BEGIN necesita un END;',
      });
    }
    // CASE blocks without a closer are omitted: they may be SQL CASE expressions
    // (ending with bare END which already popped them), so no false positives.
  }

  return errors.slice(0, 5);
}

export { validate, KEYWORD_SET };
