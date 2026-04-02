import { Router } from 'express';
import { dbPool } from '../db/client.js';

const decisionRouter = Router();

const ALLOWED_ACTIONS = new Set(['accept', 'correct-pass', 'correct-fail', 'uncertain']);
const ALLOWED_GRADES = new Set(['pass', 'fail']);

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

  if (!ALLOWED_GRADES.has(suggestedGrade)) {
    validationErrors.push({
      field: 'evaluation_result.suggested_grade',
      issue: "Must be one of: 'PASS' or 'FAIL'."
    });
  }

  if (!ALLOWED_GRADES.has(finalGrade)) {
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

  if (!inputPrompt || !inputUserAnswer || !inputExpectedAnswer) {
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

  const resolveQuery = `
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

  const resolveValues = [
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

    const resolvedItem = await client.query(resolveQuery, resolveValues);

    if (resolvedItem.rowCount === 0) {
      await client.query('ROLLBACK');
      return validationError(res, [
        {
          field: 'evaluation_item_id',
          issue: 'Unable to resolve evaluation item with provided input/result context.'
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

export default decisionRouter;
