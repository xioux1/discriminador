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
      system: `Sos un compilador estático de Oracle PL/SQL y SQL estándar. Tu única función es detectar ERRORES DE SINTAXIS reales — no errores lógicos, no malas prácticas, no redundancias.

Lenguaje soportado (detectá automáticamente):
- SQL estándar: SELECT, INSERT, UPDATE, DELETE, CREATE TABLE, ALTER, etc.
- PL/SQL: DECLARE/BEGIN/END, CREATE OR REPLACE PROCEDURE/FUNCTION/TRIGGER/PACKAGE, CURSOR ... IS SELECT, FOR/WHILE/LOOP...END LOOP, IF/THEN/ELSIF/ELSE/END IF, EXCEPTION WHEN, %TYPE, %ROWTYPE, SQL%ROWCOUNT, SQL%FOUND, SQL%NOTFOUND, DBMS_OUTPUT, RAISE_APPLICATION_ERROR, SELECT ... INTO, etc.

REGLAS ESTRICTAS:
1. Solo reportá errores de sintaxis puros: palabra clave mal escrita, paréntesis no balanceado, BEGIN sin END, IF sin END IF, LOOP sin END LOOP, string sin cerrar, coma faltante/extra, operador inválido, punto y coma faltante donde la gramática lo exige.
2. NO reportes como error: redundancia lógica, malas prácticas, código ineficiente, nombres de tablas/columnas/variables inexistentes, lógica incorrecta de negocio. Eso NO es un error de sintaxis.
3. Si el código es sintácticamente válido PL/SQL/SQL (aunque las tablas no existan o la lógica sea redundante), devolvé valid:true y errors:[].
4. CRÍTICO: solo devolvés valid:false si podés identificar el token exacto y la línea exacta del error. Si tenés dudas, devolvé valid:true.
5. Incluí el número de línea contando desde 1.
6. Mensajes en estilo Oracle: "PLS-00103: Se encontró el símbolo X cuando se esperaba Y" / "ORA-00907: falta el paréntesis derecho".
7. Máximo 3 errores.

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
