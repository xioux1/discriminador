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

  // Count standalone IF ... THEN openings (not ELSIF)
  const ifMatches   = (clean.match(/\bIF\b(?!\s*\(|\s+SQL)/g)  || []).filter(m => m === 'IF').length;
  // ELSIF doesn't open a new block
  const elsifCount  = (clean.match(/\bELSIF\b/g) || []).length;
  const endIfCount  = (clean.match(/\bEND\s+IF\b/g) || []).length;
  const openIfs     = ifMatches - elsifCount;

  if (openIfs > endIfCount) {
    const missing = openIfs - endIfCount;
    errors.push({
      line: lines.length,
      message: `PLS-00103: Falta${missing > 1 ? 'n' : ''} ${missing} END IF; — hay más IF que END IF en el bloque`,
      hint: 'Cada IF...THEN debe cerrar con END IF;'
    });
  }

  // COUNT LOOP vs END LOOP
  const loopCount    = (clean.match(/\bLOOP\b/g) || []).length;
  const endLoopCount = (clean.match(/\bEND\s+LOOP\b/g) || []).length;
  if (loopCount > endLoopCount) {
    const missing = loopCount - endLoopCount;
    errors.push({
      line: lines.length,
      message: `PLS-00103: Falta${missing > 1 ? 'n' : ''} ${missing} END LOOP; — hay más LOOP que END LOOP`,
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
      model: 'claude-sonnet-4-6',
      max_tokens: 700,
      temperature: 0,
      system: `Sos un compilador estático de Oracle PL/SQL y SQL estándar. Tu única función es detectar ERRORES DE SINTAXIS reales.

Lenguaje soportado (detectá automáticamente):
- SQL estándar: SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, ALTER, etc.
- PL/SQL: DECLARE/BEGIN/END, PROCEDURE/FUNCTION/TRIGGER/PACKAGE, CURSOR, FOR/WHILE/LOOP, IF/ELSIF/ELSE/END IF, EXCEPTION WHEN, %TYPE, %ROWTYPE, SQL%ROWCOUNT, SQL%FOUND, SQL%NOTFOUND, DBMS_OUTPUT, RAISE_APPLICATION_ERROR, SELECT...INTO, etc.

QUÉ REPORTAR (solo esto):
- Palabra clave mal escrita que rompe la sintaxis
- Paréntesis no balanceados
- BEGIN sin END correspondiente
- String literal sin cerrar
- Coma faltante o extra en lista de parámetros/columnas
- Operador inválido
- Punto y coma faltante al final de sentencias dentro de bloques PL/SQL
- Sentencia UPDATE/INSERT/DELETE/SELECT sin terminar en ;

QUÉ NO REPORTAR:
- Tablas, columnas o variables que no existen (no tenés acceso al esquema)
- Malas prácticas o código ineficiente
- Lógica de negocio incorrecta
- Redundancias

Sé preciso: solo reportá errores que podés identificar con certeza en el texto. Incluí número de línea.
Mensajes en estilo Oracle: "PLS-00103: ..." / "ORA-00907: ...".
Máximo 4 errores.

Respondé ÚNICAMENTE con JSON válido:
{ "valid": true|false, "errors": [{ "line": N, "message": "...", "hint": "..." }] }`,
      messages: [{
        role: 'user',
        content: `Analizá este código SQL/PL/SQL:\n\n${sql}`
      }]
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

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
