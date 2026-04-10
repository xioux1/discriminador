import { Router }   from 'express';
import Anthropic    from '@anthropic-ai/sdk';
import { validate as plsqlValidate } from '../services/plsql-parser.js';

const sqlValidateRouter = Router();
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
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

  // --- Step 1: structural parser (block tracking, no LLM) ---
  const structuralErrors = plsqlValidate(sql);
  if (structuralErrors.length > 0) {
    return res.status(200).json({ valid: false, errors: structuralErrors });
  }

  // --- Step 2: LLM static analysis for subtler errors ---
  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      temperature: 0,
      system: `Sos un compilador estático de Oracle SQL y PL/SQL. SOLO reportás errores de SINTAXIS que un compilador detectaría en el texto dado, sin ejecutarlo.

REPORTAR (errores de sintaxis reales solamente):
- Keyword mal escrita que rompe sintaxis (ej: SELCET, BEIGN, PROCEUDRE)
- String literal sin cerrar (comilla simple sin cierre)
- Coma faltante o extra en lista de columnas o parámetros
- Punto y coma faltante al final de sentencia PL/SQL (RETURN, asignaciones, etc.)
- SELECT sin FROM (cuando aplica)
- Declaración de variable mal formada

NO REPORTAR:
- Tablas, columnas o variables inexistentes (no tenés el esquema)
- Malas prácticas, rendimiento, lógica de negocio
- Balance de bloques IF/END IF, LOOP/END LOOP, CASE/END CASE, BEGIN/END — ya está chequeado por el parser estructural
- Paréntesis desbalanceados — ya chequeados por el frontend

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
