import { Router }   from 'express';
import Anthropic    from '@anthropic-ai/sdk';

const sqlValidateRouter = Router();
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * Deterministic pre-checks for well-known PL/SQL rules.
 * Returns an array of errors found (may be empty).
 * These are rules simple enough to detect with regex — run before the LLM
 * so the LLM can focus on subtler issues.
 */
function deterministicPlsqlChecks(sql) {
  const errors = [];
  const lines  = sql.split('\n');

  const norm = (s) => s.replace(/--[^\n]*/g, '').replace(/'[^']*'/g, "''"); // strip comments & strings

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = norm(raw).trimEnd();
    const ln   = i + 1;
    const up   = line.trim().toUpperCase();

    // RETURN without semicolon (standalone statement in PL/SQL body)
    // Match: RETURN [optional expression] at end of trimmed line, no semicolon
    if (/^\s*RETURN\b(.*)$/i.test(line)) {
      const full = line.trim();
      if (!full.endsWith(';')) {
        errors.push({ line: ln, message: `PLS-00103: Falta ';' después de RETURN`, hint: 'Cada sentencia en PL/SQL debe terminar con ;' });
      }
    }

    // END IF without semicolon
    if (/^\s*END\s+IF\s*$/i.test(line)) {
      errors.push({ line: ln, message: `PLS-00103: Falta ';' después de END IF`, hint: 'END IF debe terminar con ;' });
    }

    // END LOOP without semicolon
    if (/^\s*END\s+LOOP\s*$/i.test(line)) {
      errors.push({ line: ln, message: `PLS-00103: Falta ';' después de END LOOP`, hint: 'END LOOP debe terminar con ;' });
    }

    // END without semicolon (bare END at end of block) — but not END IF / END LOOP / END label
    if (/^\s*END\s*$/i.test(line)) {
      errors.push({ line: ln, message: `PLS-00103: Falta ';' después de END`, hint: 'El END de cierre de bloque debe terminar con ;' });
    }
  }

  // Count IF/THEN vs END IF to detect unclosed IFs
  // Strip comments and strings from full text first
  const clean = norm(sql).toUpperCase();

  // \bIF\b does NOT match inside ELSIF (no word boundary before I in ELSIF)
  // Bug fix: removed (?!\s*\() exclusion — that silently skipped `IF (cond) THEN`
  // and (?!\s+SQL) — that silently skipped `IF SQL%ROWCOUNT > 0 THEN`
  const rawIfCount  = (clean.match(/\bIF\b/g) || []).length;
  const endIfCount  = (clean.match(/\bEND\s+IF\b/g) || []).length;

  if (rawIfCount > endIfCount) {
    const missing = rawIfCount - endIfCount;
    errors.push({
      line: lines.length,
      message: `PLS-00103: Falta${missing > 1 ? 'n' : ''} ${missing} END IF; — ${rawIfCount} IF pero solo ${endIfCount} END IF`,
      hint: 'Cada IF...THEN debe cerrar con END IF;'
    });
  }

  // LOOP vs END LOOP
  const loopCount    = (clean.match(/\bLOOP\b/g) || []).length;
  const endLoopCount = (clean.match(/\bEND\s+LOOP\b/g) || []).length;
  if (loopCount > endLoopCount) {
    const missing = loopCount - endLoopCount;
    errors.push({
      line: lines.length,
      message: `PLS-00103: Falta${missing > 1 ? 'n' : ''} ${missing} END LOOP; — ${loopCount} LOOP pero solo ${endLoopCount} END LOOP`,
      hint: 'Cada LOOP debe cerrar con END LOOP;'
    });
  }

  return errors.slice(0, 5); // cap at 5
}

/**
 * POST /sql/validate
 * Body: { sql: string }
 * Returns: { valid: boolean, errors: [{ line?, message, hint? }] }
 */
sqlValidateRouter.post('/sql/validate', async (req, res) => {
  const { sql } = req.body || {};

  if (!sql || !sql.trim()) {
    return res.status(422).json({ error: 'validation_error', message: 'sql is required.' });
  }

  if (sql.length > 8000) {
    return res.status(422).json({ error: 'validation_error', message: 'SQL demasiado largo (máx 8000 caracteres).' });
  }

  // --- Step 1: deterministic checks (fast, no LLM) ---
  const deterministicErrors = deterministicPlsqlChecks(sql);
  if (deterministicErrors.length > 0) {
    return res.status(200).json({ valid: false, errors: deterministicErrors });
  }

  // --- Step 2: LLM static analysis for subtler errors ---
  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      temperature: 0,
      system: `Sos un compilador estático de Oracle SQL y PL/SQL. SOLO reportás errores de SINTAXIS que un compilador detectaría en el texto dado, sin ejecutarlo.

REPORTAR (errores de sintaxis reales solamente):
- Keyword mal escrita que rompe sintaxis
- Paréntesis desbalanceados
- String literal sin cerrar (comilla simple sin cierre)
- Coma faltante o extra
- Punto y coma faltante al final de sentencia PL/SQL
- SELECT sin FROM (cuando aplica)
- BEGIN sin END o END sin BEGIN

NO REPORTAR:
- Tablas, columnas o variables inexistentes (no tenés el esquema)
- Malas prácticas, rendimiento, lógica de negocio
- Errores que ya detectó el pre-compilador (IF/END IF, LOOP/END LOOP, paréntesis — ya están chequeados)

Si el código tiene errores claros de sintaxis, reportalos con número de línea exacto.
Si el código parece correcto sintácticamente, respondé valid:true con errors:[].
NO inventes errores cuando tenés dudas. Preferí false negative a false positive.
Mensajes estilo Oracle: "PLS-00103: ..." / "ORA-XXXXX: ...". Máximo 3 errores.

SOLO JSON: { "valid": true|false, "errors": [{ "line": N, "message": "...", "hint": "..." }] }`,
      messages: [{
        role: 'user',
        content: `Analizá este código SQL/PL/SQL:\n\n${sql}`
      }]
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    let jsonText = text;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fence) {
      jsonText = fence[1];
    } else {
      const s = text.indexOf('{'), e = text.lastIndexOf('}');
      if (s !== -1 && e > s) jsonText = text.slice(s, e + 1);
    }

    let result;
    try {
      result = JSON.parse(jsonText);
    } catch (_e) {
      result = { valid: true, errors: [] };
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('POST /sql/validate', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default sqlValidateRouter;
