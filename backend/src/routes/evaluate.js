import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { scoreEvaluation } from '../services/scoring.js';
import { judgeWithLLM } from '../services/llm-judge.js';
import { isLLMJudgeEnabled, LLM_MODELS } from '../config/env.js';
import { dbPool } from '../db/client.js';
import { llmRateLimit } from '../middleware/llm-rate-limit.js';

// Lazy Anthropic client for binary check (reused across requests).
let _checkClient = null;
function getCheckClient() {
  if (!_checkClient) _checkClient = new Anthropic();
  return _checkClient;
}

const evaluateRouter = Router();

const REQUIRED_FIELDS = [
  { key: 'prompt_text',          minLength: 10, maxLength: 2000  },
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

  const heuristicResult = scoreEvaluation({
    prompt_text: normalizedFields.prompt_text,
    user_answer_text: normalizedFields.user_answer_text,
    expected_answer_text: normalizedFields.expected_answer_text,
    subject: normalizedSubject,
    evaluation_id: evaluationId
  });

  // LLM judge: primary evaluator when enabled.
  // Falls back to heuristic if the API call fails.
  let llmJudge = null;
  let llmFallback = false;
  if (isLLMJudgeEnabled()) {
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
        console.warn('[LLM judge] Rate limit reached, falling back to heuristic.', { message: llmError.message });
      } else if (llmError.message?.toLowerCase().includes('parse')) {
        console.error('[LLM judge] Response parse failure, falling back to heuristic.', { message: llmError.message });
      } else if (llmError.status >= 500) {
        console.warn('[LLM judge] API server error, falling back to heuristic.', { status: llmError.status, message: llmError.message });
      } else {
        console.error('[LLM judge] Unexpected error, falling back to heuristic.', { message: llmError.message });
      }
    }
  }

  // Merge: LLM grade + justification override heuristic when available.
  const result = {
    ...heuristicResult,
    suggested_grade: llmJudge?.suggested_grade ?? heuristicResult.suggested_grade,
    justification_short: llmJudge?.justification ?? heuristicResult.justification_short,
    missing_concepts: llmJudge?.missing_concepts ?? [],
    signals: {
      ...heuristicResult.signals,
      ...(llmJudge ? { llm_judge: llmJudge } : {})
    }
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
             VALUES ($1, $2, $3, $4)`,
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

  if (!prompt_text || !user_answer_text || !expected_answer_text) {
    return res.status(422).json({ error: 'validation_error', message: 'Missing required fields.' });
  }

  if (String(prompt_text).length > 2000 || String(user_answer_text).length > 10000 || String(expected_answer_text).length > 5000) {
    return res.status(422).json({ error: 'validation_error', message: 'One or more fields exceed the maximum allowed length.' });
  }

  try {
    const response = await getCheckClient().messages.create({
      model: LLM_MODELS.binary,
      max_tokens: 16,
      system: `Sos un verificador de ejercicios académicos para trabajo en proceso.
El estudiante está escribiendo su respuesta y puede estar INCOMPLETA. Tu tarea es verificar si lo que escribió hasta ahora es CORRECTO, no si ya terminó.

Respondé OK cuando: lo escrito está en el camino correcto, sin errores conceptuales ni de sintaxis, aunque falte código por escribir.
Respondé ERROR cuando: hay un error real en lo ya escrito — lógica incorrecta, keyword mal usada, función usada de forma equivocada, concepto aplicado al revés.

NO respondas ERROR por: código incompleto, paréntesis sin cerrar, bloques sin END, parámetros sin terminar, o cualquier cosa que simplemente "falta" porque la respuesta está en proceso.

Respondé ÚNICAMENTE con una de estas dos líneas, sin agregar nada más:
RESULTADO: OK
RESULTADO: ERROR`,
      messages: [{
        role: 'user',
        content: `Ejercicio:\n${prompt_text}\n\nRespuesta esperada (referencia completa):\n${expected_answer_text}\n\nRespuesta del estudiante hasta ahora (puede estar incompleta):\n${user_answer_text}`
      }]
    });

    const text    = response.content.find((b) => b.type === 'text')?.text ?? '';
    const result  = /RESULTADO:\s*OK/i.test(text) ? 'ok' : 'error';

    let checkId = null;
    if (result === 'error' && userId) {
      const logRes = await dbPool.query(
        `INSERT INTO binary_check_log (user_id, card_id, subject, user_answer, result)
         VALUES ($1, $2, $3, $4, 'error') RETURNING id`,
        [userId, card_id ? Number(card_id) : null, subject || null, user_answer_text]
      );
      checkId = logRes.rows[0]?.id ?? null;
    }

    return res.json({ result, check_id: checkId });
  } catch (err) {
    console.error('POST /evaluate/binary-check', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default evaluateRouter;
