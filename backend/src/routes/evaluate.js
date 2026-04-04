import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { scoreEvaluation } from '../services/scoring.js';
import { judgeWithLLM } from '../services/llm-judge.js';
import { isLLMJudgeEnabled } from '../config/env.js';
import { dbPool } from '../db/client.js';

const evaluateRouter = Router();

const REQUIRED_FIELDS = [
  { key: 'prompt_text', minLength: 10 },
  { key: 'user_answer_text', minLength: 5 },
  { key: 'expected_answer_text', minLength: 10 }
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

evaluateRouter.post('/evaluate', async (req, res) => {
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

  for (const { key, minLength } of REQUIRED_FIELDS) {
    if (!(key in req.body)) {
      validationErrors.push({
        field: key,
        issue: 'Field is required.'
      });
      continue;
    }

    if (normalizedFields[key].length < minLength) {
      validationErrors.push({
        field: key,
        issue: `Must contain at least ${minLength} non-whitespace characters.`
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
  if (isLLMJudgeEnabled()) {
    try {
      llmJudge = await judgeWithLLM(dbPool, {
        prompt_text: normalizedFields.prompt_text,
        user_answer_text: normalizedFields.user_answer_text,
        expected_answer_text: normalizedFields.expected_answer_text,
        subject: normalizedSubject
      });
    } catch (llmError) {
      console.warn('LLM judge failed, falling back to heuristic.', {
        message: llmError.message
      });
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
        evaluator_context
      )
      VALUES ($1, $2, $3::jsonb, $4::jsonb)
      RETURNING id, created_at, updated_at
    `;

    const evaluationItemInsertValues = [
      'evaluate_api',
      sourceRecordId,
      JSON.stringify(inputPayload),
      JSON.stringify(evaluatorContext)
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
      missing_concepts: result.missing_concepts
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

export default evaluateRouter;
