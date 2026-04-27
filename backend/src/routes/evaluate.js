import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
// import { scoreEvaluation } from '../services/scoring.js';
import { judgeWithLLM } from '../services/llm-judge.js';
import { LLM_MODELS } from '../config/env.js';
import { dbPool } from '../db/client.js';
import { llmRateLimit } from '../middleware/llm-rate-limit.js';

// Lazy Anthropic client for binary check (reused across requests).
let _checkClient = null;
function getCheckClient() {
  if (!_checkClient) _checkClient = new Anthropic();
  return _checkClient;
}

// For tests only — inject a mock client.
export function __setCheckClientForTest(client) {
  _checkClient = client;
}

// ─── Binary-check mode helpers ─────────────────────────────────────────────

// Strip diacritics so 'cálculo' === 'calculo', 'física' === 'fisica', etc.
function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeForDetection(subject) {
  return typeof subject === 'string'
    ? stripDiacritics(subject.trim().toLowerCase())
    : '';
}

// All keywords are plain ASCII (diacritics handled by normalizeForDetection).
const MATH_SUBJECT_KEYWORDS = [
  // Generic math terms
  'mat', 'calc', 'alg', 'arithm', 'trig', 'geom', 'prob', 'estadist',
  // Analysis / calculus
  'analisi', 'integral', 'difer', 'ecuac', 'vectori',
  // Physics (uses equations — math-first prompt applies)
  'fis',
  // Chemistry (equations, stoichiometry)
  'quim',
  // Argentine/Latin-American curriculum shortcodes
  'am1', 'am2', 'am3', 'am4',   // Análisis Matemático 1-4
  'edo',                          // Ecuaciones Diferenciales Ordinarias
  'alc',                          // Álgebra y Cálculo (some curricula)
];
const SQL_SUBJECT_KEYWORDS = [
  'sql', 'base', 'datos', 'bd', 'oracle', 'pl/sql', 'plsql', 'query',
  'consult', 'stored', 'cursor', 'trigger', 'procedure'
];

function detectCheckMode(subject) {
  const s = normalizeForDetection(subject);
  if (!s) return 'generic';
  if (MATH_SUBJECT_KEYWORDS.some((k) => s.includes(k))) return 'math';
  if (SQL_SUBJECT_KEYWORDS.some((k) => s.includes(k)))  return 'sql';
  return 'generic';
}

function getBinaryCheckPrompt(mode) {
  if (mode === 'math') {
    return `Sos un verificador matemático en tiempo real. El estudiante está resolviendo un ejercicio y su respuesta puede estar INCOMPLETA.

Tu única tarea: detectar si el estudiante YA cometió un error matemático real. NO evaluás si siguió el camino de la solución de referencia.

PRINCIPIO CENTRAL: la solución esperada es un objetivo/referencia, NO el único procedimiento válido. Aceptá cualquier camino alternativo matemáticamente correcto.

━━━ DECÍ OK cuando ━━━
• El trabajo actual es matemáticamente válido aunque esté incompleto
• El alumno usa un camino distinto (sustitución diferente, fórmula directa, integración por partes, otro método) pero correcto
• En integrales: antiderivadas que difieren por constante — ambas son correctas
• En ecuaciones diferenciales: formas implícitas o explícitas equivalentes que satisfacen la ecuación
• Simplificación algebraica equivalente, reordenamiento, factorización diferente
• La respuesta está incompleta pero lo escrito no contiene error claro
• Hay ambigüedad razonable o no podés determinar con certeza si hay error
• Notación levemente diferente pero matemáticamente equivalente

━━━ DECÍ ERROR solo cuando ━━━
• Hay un error matemático claro e inequívoco: derivada/integral mal calculada, regla mal aplicada
• Error algebraico claro: expansión incorrecta, simplificación que altera la expresión
• Cambio injustificado del integrando o de la expresión original
• Error conceptual que demuestra incomprensión real del tema (no ambigüedad de notación)

━━━ NUNCA es ERROR ━━━
• Seguir un camino diferente al de la solución de referencia
• Usar una fórmula conocida en lugar de derivarla paso a paso
• Tener menos o más pasos que la solución esperada
• Cualquier ambigüedad — ante la duda, OK

No reveles la solución ni des pistas largas.

Cuando el resultado es ERROR, clasificalo:
• ERROR_TYPE: "conceptual" → error matemático que afecta la corrección del resultado
• ERROR_TYPE: "syntactic" → error de notación sin impacto matemático real
• ERROR_LABEL: descripción breve del error en ≤60 caracteres (solo para conceptual)

Respondé ÚNICAMENTE en este formato exacto, sin texto adicional:

Para respuesta correcta o ambigua:
RESULTADO: OK

Para error claro:
RESULTADO: ERROR
ERROR_TYPE: conceptual|syntactic
ERROR_LABEL: descripción breve (solo si conceptual)`;
  }

  if (mode === 'sql') {
    return `Sos un verificador en tiempo real de ejercicios de SQL/PL-SQL. El estudiante está escribiendo su respuesta y puede estar INCOMPLETA. Tu única tarea: detectar si ya cometió un error real, no si ya terminó.

PRINCIPIO GUÍA: preferí decir OK cuando tenés dudas. Un falso ERROR interrumpe al estudiante sin razón. Un falso OK simplemente no lo ayuda todavía.

━━━ DECÍ OK cuando ━━━
• Lo escrito está en la dirección correcta, aunque falte código por escribir
• El código está incompleto de forma natural: BEGIN sin END, DECLARE vacío, paréntesis abiertos, bloques a medio escribir, sentencias sin terminar
• Hay errores de forma que no afectan la lógica: mayúsculas, espaciado, convenciones de nombres, typos menores
• No podés determinar con certeza si es un error (la respuesta está muy incompleta para juzgar)

━━━ DECÍ ERROR solo cuando ━━━
• Usa la estructura equivocada para lo pedido: FUNCTION cuando pide PROCEDURE, SELECT sin cursor cuando claramente necesita uno, etc.
• La lógica del algoritmo es incorrecta: condición invertida, operación con sentido equivocado, loop que nunca termina por diseño incorrecto
• Usa una cláusula SQL con propósito equivocado: WHERE en lugar de HAVING para grupos, JOIN incorrecto para la relación pedida
• Hay un error conceptual claro que demuestra incomprensión del tema central — no un typo, no una convención

━━━ NUNCA es ERROR ━━━
• Código incompleto (falta cerrar bloques, terminar sentencias, agregar parámetros, escribir el resto)
• Convenciones de nombres (prefijos pro_, f_, v_, etc.) — lo evalúa otro sistema
• Tablas o columnas inexistentes (no tenés el esquema)
• Cualquier ambigüedad — si no estás seguro, OK

Cuando el resultado es ERROR, clasificalo:
• ERROR_TYPE: "conceptual" → error de lógica o concepto que afecta la corrección del resultado
• ERROR_TYPE: "syntactic" → detalle de forma sin impacto en el resultado
• ERROR_LABEL: descripción breve del error en ≤60 caracteres (solo para conceptual)

Respondé ÚNICAMENTE en este formato, sin texto adicional:
Para respuesta correcta → RESULTADO: OK
Para error →
RESULTADO: ERROR
ERROR_TYPE: conceptual|syntactic
ERROR_LABEL: descripción breve (solo si conceptual)`;
  }

  // generic fallback
  return `Sos un verificador en tiempo real de ejercicios académicos. El estudiante está escribiendo su respuesta y puede estar INCOMPLETA. Tu única tarea: detectar si ya cometió un error real, no si ya terminó.

PRINCIPIO GUÍA: preferí decir OK cuando tenés dudas. Un falso ERROR interrumpe al estudiante sin razón. Un falso OK simplemente no lo ayuda todavía.

━━━ DECÍ OK cuando ━━━
• Lo escrito está en la dirección correcta, aunque falte contenido por escribir
• La respuesta está incompleta de forma natural
• Hay errores de forma que no afectan la lógica
• No podés determinar con certeza si es un error

━━━ DECÍ ERROR solo cuando ━━━
• Usa la estructura equivocada para lo pedido
• La lógica es incorrecta de forma clara e inequívoca
• Hay un error conceptual claro que demuestra incomprensión del tema central

━━━ NUNCA es ERROR ━━━
• Respuesta incompleta
• Cualquier ambigüedad — si no estás seguro, OK

Cuando el resultado es ERROR, clasificalo:
• ERROR_TYPE: "conceptual" → error de lógica o concepto que afecta la corrección del resultado
• ERROR_TYPE: "syntactic" → detalle de forma sin impacto en el resultado
• ERROR_LABEL: descripción breve del error en ≤60 caracteres (solo para conceptual)

Respondé ÚNICAMENTE en este formato, sin texto adicional:
Para respuesta correcta → RESULTADO: OK
Para error →
RESULTADO: ERROR
ERROR_TYPE: conceptual|syntactic
ERROR_LABEL: descripción breve (solo si conceptual)`;
}

// Returns { result, errorType, errorLabel, parsedOk }
// parsedOk=false means the model response was malformed — caller must NOT log to binary_check_log.
function parseBinaryCheckOutput(text) {
  if (!/RESULTADO:/i.test(text)) {
    // No RESULTADO line at all — completely malformed response, safe fallback
    return { result: 'ok', errorType: null, errorLabel: null, parsedOk: false };
  }

  if (/RESULTADO:\s*OK/i.test(text)) {
    return { result: 'ok', errorType: null, errorLabel: null, parsedOk: true };
  }

  if (!/RESULTADO:\s*ERROR/i.test(text)) {
    // Has RESULTADO: but value is neither OK nor ERROR — ambiguous, safe fallback
    return { result: 'ok', errorType: null, errorLabel: null, parsedOk: false };
  }

  // Confirmed ERROR — extract type and label
  const lines = text.replace(/\r\n/g, '\n').trim().split('\n').map((l) => l.trim()).filter(Boolean);
  const errorTypeLine = lines.find((l) => /^ERROR_TYPE:/i.test(l));
  const errorLblLine  = lines.find((l) => /^ERROR_LABEL:/i.test(l));

  const rawType  = errorTypeLine ? errorTypeLine.replace(/^ERROR_TYPE:\s*/i, '').trim().toLowerCase() : null;
  const rawLabel = errorLblLine  ? (errorLblLine.replace(/^ERROR_LABEL:\s*/i, '').trim() || null) : null;

  const safeType  = (rawType === 'conceptual' || rawType === 'syntactic') ? rawType : 'unknown';
  const safeLabel = safeType === 'conceptual' ? rawLabel : null;

  return { result: 'error', errorType: safeType, errorLabel: safeLabel, parsedOk: true };
}

// Exported for unit tests (pure functions, no HTTP layer needed).
export { detectCheckMode, parseBinaryCheckOutput };

const evaluateRouter = Router();

const REQUIRED_FIELDS = [
  { key: 'prompt_text',          minLength: 1,  maxLength: 2000  },
  { key: 'user_answer_text',     minLength: 1,  maxLength: 10000 },
  { key: 'expected_answer_text', minLength: 1,  maxLength: 5000  },
];

function normalize(value) {
  return typeof value === 'string' ? value.trim() : '';
}


function badRequest(res, details) {
  return res.status(400).json({
    error: 'bad_request',
    message: 'Invalid JSON payload or unsupported Content-Type.',
    details
  });
}

function validationError(res, details) {
  return res.status(422).json({
    error: 'validation_error',
    message: 'One or more fields failed validation.',
    details
  });
}

evaluateRouter.post('/evaluate', llmRateLimit, async (req, res) => {
  const userId = req.user?.id ?? null;
  if (!req.is('application/json')) {
    return badRequest(res, [
      {
        field: 'body',
        issue: 'Unsupported Content-Type. Expected application/json.'
      }
    ]);
  }

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return badRequest(res, [
      {
        field: 'body',
        issue: 'Malformed JSON'
      }
    ]);
  }

  const typeErrors = [];

  for (const { key } of REQUIRED_FIELDS) {
    if (key in req.body && typeof req.body[key] !== 'string') {
      typeErrors.push({
        field: key,
        issue: 'Must be a string.'
      });
    }
  }

  if ('subject' in req.body && req.body.subject !== undefined && typeof req.body.subject !== 'string') {
    typeErrors.push({
      field: 'subject',
      issue: 'Must be a string.'
    });
  }

  if (typeErrors.length > 0) {
    return badRequest(res, typeErrors);
  }

  const validationErrors = [];

  const normalizedFields = Object.fromEntries(
    REQUIRED_FIELDS.map(({ key }) => [key, normalize(req.body[key])])
  );

  for (const { key, minLength, maxLength } of REQUIRED_FIELDS) {
    if (!(key in req.body)) {
      validationErrors.push({
        field: key,
        issue: 'Field is required.'
      });
      continue;
    }

    const val = normalizedFields[key];
    if (val.length < minLength) {
      validationErrors.push({
        field: key,
        issue: `Must contain at least ${minLength} non-whitespace characters.`
      });
    }
    if (val.length > maxLength) {
      validationErrors.push({
        field: key,
        issue: `Must not exceed ${maxLength} characters.`
      });
    }
  }

  if ('subject' in req.body && req.body.subject !== undefined) {
    const subject = normalize(req.body.subject);

    if (subject.length < 1 || subject.length > 60) {
      validationErrors.push({
        field: 'subject',
        issue: 'Must contain between 1 and 60 characters.'
      });
    }
  }

  if (validationErrors.length > 0) {
    return validationError(res, validationErrors);
  }

  const normalizedSubject = normalize(req.body.subject);
  const evaluationId = randomUUID();

  // Look up grading_strictness configured for this subject (default 5 = standard).
  let gradingStrictness = 5;
  if (userId && normalizedSubject) {
    try {
      const { rows: cfgRows } = await dbPool.query(
        'SELECT grading_strictness FROM subject_configs WHERE subject = $1 AND user_id = $2',
        [normalizedSubject, userId]
      );
      if (cfgRows[0]?.grading_strictness != null) {
        const raw = Number(cfgRows[0].grading_strictness);
        gradingStrictness = Number.isFinite(raw) ? Math.min(10, Math.max(0, raw)) : 5;
      }
    } catch (_) { /* non-critical — proceed with default */ }
  }

  // const heuristicResult = scoreEvaluation({ ... }); // disabled — LLM is sole evaluator

  let llmJudge = null;
  let llmFallback = false;
  try {
    llmJudge = await judgeWithLLM(dbPool, {
      prompt_text: normalizedFields.prompt_text,
      user_answer_text: normalizedFields.user_answer_text,
      expected_answer_text: normalizedFields.expected_answer_text,
      subject: normalizedSubject,
      strictness: gradingStrictness
    });
  } catch (llmError) {
    llmFallback = true;
    if (llmError.status === 429) {
      console.warn('[LLM judge] Rate limit reached.', { message: llmError.message });
    } else if (llmError.message?.toLowerCase().includes('parse')) {
      console.error('[LLM judge] Response parse failure.', { message: llmError.message });
    } else if (llmError.status >= 500) {
      console.warn('[LLM judge] API server error.', { status: llmError.status, message: llmError.message });
    } else {
      console.error('[LLM judge] Unexpected error.', { message: llmError.message });
    }
  }

  const result = {
    suggested_grade:    llmJudge?.suggested_grade  ?? 'HARD',
    justification_short: llmJudge?.justification   ?? 'No se pudo evaluar automáticamente.',
    missing_concepts:   llmJudge?.missing_concepts  ?? [],
    dimensions:         { core_idea: null, conceptual_accuracy: null, completeness: null, memorization_risk: null },
    overall_score:      null,
    model_confidence:   null,
    signals:            { ...(llmJudge ? { llm_judge: llmJudge } : {}) },
  };

  const sourceRecordId = evaluationId;

  const inputPayload = {
    prompt_text: normalizedFields.prompt_text,
    user_answer_text: normalizedFields.user_answer_text,
    expected_answer_text: normalizedFields.expected_answer_text,
    subject: normalizedSubject || null
  };

  const evaluatorContext = {
    overall_score: result.overall_score,
    dimensions: result.dimensions,
    model_confidence: result.model_confidence
  };

  let client;

  try {
    client = await dbPool.connect();
    await client.query('BEGIN');

    const evaluationItemInsertQuery = `
      INSERT INTO evaluation_items (
        source_system,
        source_record_id,
        input_payload,
        evaluator_context,
        user_id
      )
      VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
      RETURNING id, created_at, updated_at
    `;

    const evaluationItemInsertValues = [
      'evaluate_api',
      sourceRecordId,
      JSON.stringify(inputPayload),
      JSON.stringify(evaluatorContext),
      userId
    ];

    const evaluationItemInsertResult = await client.query(
      evaluationItemInsertQuery,
      evaluationItemInsertValues
    );

    const evaluationItem = evaluationItemInsertResult.rows[0];

    const gradeSuggestionInsertQuery = `
      INSERT INTO grade_suggestions (
        evaluation_item_id,
        suggested_grade,
        confidence,
        model_name,
        model_version,
        explanation
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, created_at
    `;

    const gradeSuggestionInsertValues = [
      evaluationItem.id,
      result.suggested_grade.toLowerCase(),
      result.model_confidence,
      llmJudge ? 'llm_judge' : 'heuristic_discriminator',
      llmJudge ? llmJudge.model : 'v1',
      result.justification_short
    ];

    const gradeSuggestionInsertResult = await client.query(
      gradeSuggestionInsertQuery,
      gradeSuggestionInsertValues
    );

    const gradeSuggestion = gradeSuggestionInsertResult.rows[0];

    const evaluationSignalsInsertQuery = `
      INSERT INTO evaluation_signals (
        evaluation_item_id,
        evaluation_id,
        prompt_text,
        subject,
        keyword_coverage,
        answer_length_ratio,
        lexical_similarity,
        dimensions,
        suggested_grade
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
      RETURNING id, created_at
    `;

    const evaluationSignalsInsertValues = [
      evaluationItem.id,
      evaluationId,
      normalizedFields.prompt_text,
      normalizedSubject || null,
      result.signals.keywordCoverage,
      result.signals.answerLengthRatio,
      result.signals.lexicalSimilarity,
      JSON.stringify(result.dimensions),
      result.suggested_grade.toLowerCase()
    ];

    let evaluationSignals = null;

    await client.query('SAVEPOINT persist_evaluation_signals');

    try {
      const evaluationSignalsInsertResult = await client.query(
        evaluationSignalsInsertQuery,
        evaluationSignalsInsertValues
      );

      evaluationSignals = evaluationSignalsInsertResult.rows[0];
    } catch (signalsError) {
      await client.query('ROLLBACK TO SAVEPOINT persist_evaluation_signals');

      if (signalsError?.code === '42P01') {
        console.warn(
          'Skipping evaluation_signals persistence because table does not exist.',
          {
            code: signalsError.code,
            message: signalsError.message
          }
        );
      } else {
        throw signalsError;
      }
    } finally {
      await client.query('RELEASE SAVEPOINT persist_evaluation_signals');
    }

    // Persist concept gaps extracted by the LLM judge (best-effort, non-blocking).
    if (result.missing_concepts.length > 0) {
      await client.query('SAVEPOINT persist_concept_gaps');
      try {
        for (const concept of result.missing_concepts) {
          await client.query(
            `INSERT INTO concept_gaps (evaluation_item_id, concept, subject, prompt_text)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (evaluation_item_id, concept) DO NOTHING`,
            [
              evaluationItem.id,
              concept,
              normalizedSubject || null,
              normalizedFields.prompt_text
            ]
          );
        }
      } catch (gapsError) {
        await client.query('ROLLBACK TO SAVEPOINT persist_concept_gaps');
        if (gapsError?.code === '42P01') {
          console.warn('Skipping concept_gaps persistence because table does not exist.', {
            code: gapsError.code,
            message: gapsError.message
          });
        } else {
          throw gapsError;
        }
      } finally {
        await client.query('RELEASE SAVEPOINT persist_concept_gaps');
      }
    }

    await client.query('COMMIT');

    console.info('Persisted evaluation flow records', {
      evaluation_id: evaluationId,
      evaluation_item: evaluationItem,
      grade_suggestion: gradeSuggestion,
      evaluation_signals: evaluationSignals
    });

    return res.status(200).json({
      ...result,
      evaluation_id: evaluationId,
      prompt_text: normalizedFields.prompt_text,
      subject: normalizedSubject || null,
      missing_concepts: result.missing_concepts,
      llm_fallback: llmFallback
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }

    console.error('Error while persisting /evaluate flow records', {
      message: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      error: 'server_error',
      message: 'Failed to persist evaluation data.'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// ─── Binary check ─────────────────────────────────────────────────────────────
// POST /evaluate/binary-check
// Uses the most powerful model available to give a binary yes/no verdict on
// whether the student's current answer is correct.  No details are leaked.
// Negative results are logged to binary_check_log to feed the penalty system
// and micro-card generation.
evaluateRouter.post('/evaluate/binary-check', llmRateLimit, async (req, res) => {
  const userId = req.user?.id ?? null;
  const { card_id, prompt_text, user_answer_text, expected_answer_text, subject } = req.body || {};

  if (!prompt_text || !user_answer_text) {
    return res.status(422).json({ error: 'validation_error', message: 'Missing required fields.' });
  }

  if (String(prompt_text).length > 2000 || String(user_answer_text).length > 10000 || (expected_answer_text && String(expected_answer_text).length > 5000)) {
    return res.status(422).json({ error: 'validation_error', message: 'One or more fields exceed the maximum allowed length.' });
  }

  const mode = detectCheckMode(subject);

  try {
    const response = await getCheckClient().messages.create({
      model: LLM_MODELS.binary,
      max_tokens: 120,
      temperature: 0,
      system: getBinaryCheckPrompt(mode),
      messages: [{
        role: 'user',
        content: `Ejercicio:\n${prompt_text}${expected_answer_text ? `\n\nSolución de referencia (usala como referencia del objetivo, no como único camino válido):\n${expected_answer_text}` : ''}\n\nRespuesta del estudiante hasta ahora (puede estar incompleta):\n${user_answer_text}`
      }]
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    const { result, errorType, errorLabel, parsedOk } = parseBinaryCheckOutput(text);

    // Only log confirmed errors — never log format-fallback OKs (parsedOk=false)
    let checkId = null;
    if (result === 'error' && parsedOk && userId) {
      const logRes = await dbPool.query(
        `INSERT INTO binary_check_log (user_id, card_id, subject, user_answer, result, error_type, error_label)
         VALUES ($1, $2, $3, $4, 'error', $5, $6) RETURNING id`,
        [userId, card_id ? Number(card_id) : null, subject || null, user_answer_text,
         errorType, errorType === 'conceptual' ? errorLabel : null]
      );
      checkId = logRes.rows[0]?.id ?? null;
    }

    return res.json({
      result,
      check_id:    checkId,
      error_type:  result === 'error' ? errorType : null,
      error_label: errorType === 'conceptual' ? errorLabel : null
    });
  } catch (err) {
    console.error('POST /evaluate/binary-check', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default evaluateRouter;
