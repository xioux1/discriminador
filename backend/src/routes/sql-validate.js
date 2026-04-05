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
      max_tokens: 600,
      temperature: 0,
      system: `Sos un parser estático de Oracle PL/SQL y SQL estándar. Analizás código SQL/PL/SQL y reportás errores de sintaxis exactamente como lo haría el compilador de Oracle.

Lenguaje soportado (detectá automáticamente):
- SQL estándar: SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, etc.
- PL/SQL: bloques DECLARE/BEGIN/END, procedimientos (CREATE OR REPLACE PROCEDURE), funciones (CREATE OR REPLACE FUNCTION), triggers (CREATE OR REPLACE TRIGGER), paquetes (CREATE PACKAGE), cursores (CURSOR ... IS SELECT), loops (FOR/WHILE/LOOP ... END LOOP), condicionales (IF/THEN/ELSIF/ELSE/END IF), excepciones (EXCEPTION WHEN), tipos (%TYPE, %ROWTYPE), DBMS_OUTPUT, etc.

Reglas:
- Analizá SOLO la sintaxis — no ejecutes ni valides semántica (nombres de tablas/columnas/paquetes no importan).
- Detectá: palabras clave mal escritas, comas faltantes o extras, paréntesis no balanceados, bloques BEGIN sin END, IF sin END IF, LOOP sin END LOOP, strings sin cerrar, operadores inválidos, punto y coma faltante al final de statements PL/SQL, etc.
- Los mensajes de error deben ser claros y en el estilo del compilador Oracle: "PLS-00103: Se encontró el símbolo \\"X\\" cuando se esperaba..." o "ORA-00907: falta el paréntesis derecho".
- Incluí el número de línea donde ocurre el error (contando desde 1).
- Si la sintaxis es válida (aunque las tablas no existan), devolvé valid:true y errors:[].
- Sé conciso. Si hay múltiples errores, reportá el primero y los más obvios (máx 3).

Respondé ÚNICAMENTE con JSON válido, sin texto adicional:
{
  "valid": true|false,
  "errors": [
    { "line": 3, "message": "PLS-00103: Se encontró el símbolo \\"FORM\\" cuando se esperaba FROM", "hint": "¿Quisiste escribir FROM?" }
  ]
}`,
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
