import { Router } from 'express';
import { dbPool } from '../db/client.js';

const decisionRouter = Router();

const ALLOWED_ACTIONS = new Set(['accept', 'correct-pass', 'correct-fail', 'uncertain']);
const ALLOWED_FINAL_GRADES = new Set(['pass', 'fail']);
const ALLOWED_SUGGESTED_GRADES = new Set(['pass', 'review', 'fail']);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function validationError(res, details) {
  return res.status(422).json({
    error: 'validation_error',
    message: 'One or more fields failed validation.',
    details
  });
}

function toDecisionType(action) {
  if (action === 'accept') {
    return 'accepted';
  }

  if (action === 'uncertain') {
    return 'uncertain';
  }

  return 'corrected';
}

function resolveFinalGrade(action, finalGrade, suggestedGrade) {
  const normalizedFinalGrade = normalizeString(finalGrade).toLowerCase();
  const normalizedSuggestedGrade = normalizeString(suggestedGrade).toLowerCase();

  if (action === 'correct-pass') {
    return 'pass';
  }

  if (action === 'correct-fail') {
    return 'fail';
  }

  if (action === 'accept') {
    return normalizedFinalGrade;
  }

  return normalizedFinalGrade || normalizedSuggestedGrade;
}

decisionRouter.post('/decision', async (req, res) => {
  if (!req.is('application/json')) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Unsupported Content-Type. Expected application/json.'
    });
  }

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Malformed JSON payload.'
    });
  }

  const action = normalizeString(req.body.action);
  const correctionReason = normalizeString(req.body.correction_reason);
  const evaluationResult = req.body.evaluation_result && typeof req.body.evaluation_result === 'object'
    ? req.body.evaluation_result
    : null;

  const suggestedGrade = normalizeString(evaluationResult?.suggested_grade).toLowerCase();
  const finalGrade = resolveFinalGrade(action, req.body.final_grade, suggestedGrade);
  const acceptedSuggestion = req.body.accepted_suggestion;
  const evaluationId = normalizeString(req.body.evaluation_id);

  const validationErrors = [];

  if (!ALLOWED_ACTIONS.has(action)) {
    validationErrors.push({
      field: 'action',
      issue: "Must be one of: 'accept', 'correct-pass', 'correct-fail', 'uncertain'."
    });
  }

  if (!evaluationResult) {
    validationErrors.push({
      field: 'evaluation_result',
      issue: 'Field is required and must be an object.'
    });
  }

  if (!ALLOWED_SUGGESTED_GRADES.has(suggestedGrade)) {
    validationErrors.push({
      field: 'evaluation_result.suggested_grade',
      issue: "Must be one of: 'PASS', 'REVIEW' or 'FAIL'."
    });
  }

  if (!ALLOWED_FINAL_GRADES.has(finalGrade)) {
    validationErrors.push({
      field: 'final_grade',
      issue: "Must resolve to one of: 'PASS' or 'FAIL'."
    });
  }

  if (typeof acceptedSuggestion !== 'boolean') {
    validationErrors.push({
      field: 'accepted_suggestion',
      issue: 'Must be a boolean.'
    });
  }

  if ((action === 'correct-pass' || action === 'correct-fail' || action === 'uncertain') && correctionReason.length < 5) {
    validationErrors.push({
      field: 'correction_reason',
      issue: 'Must contain at least 5 characters for correction/uncertain decisions.'
    });
  }

  if (action === 'accept' && acceptedSuggestion !== true) {
    validationErrors.push({
      field: 'accepted_suggestion',
      issue: 'Must be true when action is accept.'
    });
  }

  if ((action === 'correct-pass' || action === 'correct-fail') && acceptedSuggestion !== false) {
    validationErrors.push({
      field: 'accepted_suggestion',
      issue: 'Must be false when action is a correction.'
    });
  }

  if (validationErrors.length > 0) {
    return validationError(res, validationErrors);
  }

  const inputPrompt = normalizeString(req.body.prompt_text);
  const inputUserAnswer = normalizeString(req.body.user_answer_text);
  const inputExpectedAnswer = normalizeString(req.body.expected_answer_text);
  const inputSubject = normalizeString(req.body.subject);

  if (!evaluationId && (!inputPrompt || !inputUserAnswer || !inputExpectedAnswer)) {
    return validationError(res, [
      {
        field: 'prompt_text/user_answer_text/expected_answer_text',
        issue: 'Input context fields are required to resolve evaluation_item_id.'
      }
    ]);
  }

  const overallScore = Number(evaluationResult.overall_score);
  const modelConfidence = Number(evaluationResult.model_confidence);
  const dimensions = evaluationResult.dimensions;

  if (!Number.isFinite(overallScore) || !Number.isFinite(modelConfidence) || !dimensions || typeof dimensions !== 'object') {
    return validationError(res, [
      {
        field: 'evaluation_result',
        issue: 'Must include overall_score, model_confidence and dimensions to resolve evaluation_item_id.'
      }
    ]);
  }

  const resolveByEvaluationIdQuery = `
    SELECT id
    FROM evaluation_items
    WHERE source_system = 'evaluate_api'
      AND source_record_id = $1
    ORDER BY id DESC
    LIMIT 1
  `;

  const resolveByContextQuery = `
    SELECT ei.id
    FROM evaluation_items ei
    INNER JOIN grade_suggestions gs ON gs.evaluation_item_id = ei.id
    WHERE ei.source_system = 'evaluate_api'
      AND ei.input_payload->>'prompt_text' = $1
      AND ei.input_payload->>'user_answer_text' = $2
      AND ei.input_payload->>'expected_answer_text' = $3
      AND COALESCE(ei.input_payload->>'subject', '') = $4
      AND (ei.evaluator_context->>'overall_score')::numeric = $5
      AND (ei.evaluator_context->>'model_confidence')::numeric = $6
      AND gs.suggested_grade = $7
      AND gs.confidence = $8
    ORDER BY ei.id DESC
    LIMIT 1
  `;

  const resolveByContextValues = [
    inputPrompt,
    inputUserAnswer,
    inputExpectedAnswer,
    inputSubject,
    overallScore,
    modelConfidence,
    suggestedGrade,
    modelConfidence
  ];

  let client;

  try {
    client = await dbPool.connect();
    await client.query('BEGIN');

    const resolvedItem = evaluationId
      ? await client.query(resolveByEvaluationIdQuery, [evaluationId])
      : await client.query(resolveByContextQuery, resolveByContextValues);

    if (resolvedItem.rowCount === 0) {
      await client.query('ROLLBACK');
      return validationError(res, [
        {
          field: 'evaluation_item_id',
          issue: 'Unable to resolve evaluation item with provided evaluation_id or input/result context.'
        }
      ]);
    }

    const evaluationItemId = resolvedItem.rows[0].id;

    const insertQuery = `
      INSERT INTO user_decisions (
        evaluation_item_id,
        final_grade,
        decision_type,
        reason,
        decided_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      RETURNING id, evaluation_item_id, final_grade, decision_type, reason, decided_at
    `;

    const insertValues = [
      evaluationItemId,
      finalGrade,
      toDecisionType(action),
      correctionReason || null
    ];

    const insertResult = await client.query(insertQuery, insertValues);
    await client.query('COMMIT');

    const decision = insertResult.rows[0];

    return res.status(201).json({
      status: 'saved',
      success: true,
      decision: {
        id: decision.id,
        evaluation_id: evaluationId || null,
        evaluation_item_id: decision.evaluation_item_id,
        action,
        final_grade: decision.final_grade,
        accepted_suggestion: acceptedSuggestion,
        correction_reason: decision.reason,
        finalized_at: decision.decided_at
      }
    });
  } catch (error) {
    if (client) {
      await client.query('ROLLBACK');
    }

    console.error('Error while persisting /decision flow records', {
      message: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      error: 'server_error',
      message: 'Failed to persist decision data.'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});



decisionRouter.get('/decision/audit/latest', async (req, res) => {
  const rawLimit = Number.parseInt(normalizeString(req.query.limit), 10);
  const limit = Number.isNaN(rawLimit) ? 100 : Math.min(Math.max(rawLimit, 1), 100);

  const latestSignalsQuery = `
    SELECT
      es.evaluation_id,
      es.prompt_text,
      es.subject,
      es.keyword_coverage,
      es.answer_length_ratio,
      es.lexical_similarity,
      es.dimensions,
      es.suggested_grade,
      ei.created_at AS evaluated_at,
      ud.final_grade,
      ud.decision_type,
      ud.reason AS decision_reason,
      ud.decided_at
    FROM evaluation_signals es
    INNER JOIN evaluation_items ei ON ei.id = es.evaluation_item_id
    LEFT JOIN LATERAL (
      SELECT final_grade, decision_type, reason, decided_at
      FROM user_decisions
      WHERE evaluation_item_id = ei.id
      ORDER BY decided_at DESC
      LIMIT 1
    ) ud ON true
    ORDER BY es.created_at DESC
    LIMIT $1
  `;

  try {
    const { rows } = await dbPool.query(latestSignalsQuery, [limit]);

    return res.status(200).json({
      count: rows.length,
      limit,
      data: rows
    });
  } catch (error) {
    console.error('Error while listing evaluation signals audit records', {
      message: error.message,
      stack: error.stack
    });

    return res.status(500).json({
      error: 'server_error',
      message: 'Failed to fetch evaluation signals audit data.'
    });
  }
});

export default decisionRouter;
