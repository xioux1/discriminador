import { Router }   from 'express';
import Anthropic    from '@anthropic-ai/sdk';

const sqlValidateRouter = Router();
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

/**
 * POST /sql/validate
 * Body: { sql: string }
 * Returns: { valid: boolean, errors: [{ message, hint? }] }
 *
 * Uses claude-haiku as a PostgreSQL syntax parser (static analysis only,
 * no query execution). Errors are formatted like real PostgreSQL output.
 */
sqlValidateRouter.post('/sql/validate', async (req, res) => {
  const { sql } = req.body || {};

  if (!sql || !sql.trim()) {
    return res.status(422).json({ error: 'validation_error', message: 'sql is required.' });
  }

  if (sql.length > 8000) {
    return res.status(422).json({ error: 'validation_error', message: 'SQL demasiado largo (máx 8000 caracteres).' });
  }

  try {
    const response = await getClient().messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      temperature: 0,
      system: `Sos un parser estático de PostgreSQL. Analizás una consulta SQL y reportás errores de sintaxis exactamente como lo haría el motor de PostgreSQL.

Reglas:
- Analizá SOLO la sintaxis — no ejecutes ni valides semántica (nombres de tablas/columnas no importan).
- Detectá: palabras clave mal escritas, comas faltantes o extras, paréntesis no balanceados, cláusulas en orden incorrecto, strings sin cerrar, operadores inválidos.
- Los mensajes de error deben seguir el formato de PostgreSQL: "ERROR: syntax error at or near \\"token\\"" o "ERROR: unterminated quoted string at or near..."
- Si la sintaxis es válida (aunque las tablas no existan), devolvé valid:true y errors:[].
- Sé conciso. Si hay múltiples errores, reportá el primero y los más obvios (máx 3).

Respondé ÚNICAMENTE con JSON válido, sin texto adicional:
{
  "valid": true|false,
  "errors": [
    { "message": "ERROR: syntax error at or near \\"FORM\\"", "hint": "¿Quisiste escribir FROM?" }
  ]
}`,
      messages: [{
        role: 'user',
        content: `Analizá esta consulta SQL:\n\n${sql}`
      }]
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

    let result;
    try {
      result = JSON.parse(jsonText);
    } catch (_e) {
      // If parsing fails, treat as valid (don't block the student)
      result = { valid: true, errors: [] };
    }

    return res.status(200).json(result);
  } catch (err) {
    console.error('POST /sql/validate', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default sqlValidateRouter;
