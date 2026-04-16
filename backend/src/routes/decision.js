import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { computeNextReview, isPassGrade, isFailGrade } from '../services/scheduler.js';
import { generateMicroCard } from '../services/micro-generator.js';

const decisionRouter = Router();

const ALLOWED_ACTIONS = new Set([
  'accept', 'uncertain',
  // 4-grade corrections
  'correct-again', 'correct-hard', 'correct-good', 'correct-easy',
  // legacy compat
  'correct-pass', 'correct-fail'
]);
const ALLOWED_FINAL_GRADES = new Set(['again', 'hard', 'good', 'easy', 'pass', 'fail']);
const ALLOWED_SUGGESTED_GRADES = new Set(['again', 'hard', 'good', 'easy', 'pass', 'review', 'fail']);

const CORRECTION_ACTIONS = new Set([
  'correct-again', 'correct-hard', 'correct-good', 'correct-easy',
  'correct-pass', 'correct-fail'
]);

function pickTopGap(gaps = []) {
  const selected = gaps.find((gap) => typeof gap?.concept === 'string' && gap.concept.trim().length > 0);
  return selected ? [selected] : [];
}

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
  // New 4-grade explicit corrections
  if (action === 'correct-again') return 'again';
  if (action === 'correct-hard')  return 'hard';
  if (action === 'correct-good')  return 'good';
  if (action === 'correct-easy')  return 'easy';
  // Legacy corrections (map to new equivalents)
  if (action === 'correct-pass')  return 'good';
  if (action === 'correct-fail')  return 'again';

  const normalizedFinalGrade    = normalizeString(finalGrade).toLowerCase();
  const normalizedSuggestedGrade = normalizeString(suggestedGrade).toLowerCase();

  if (action === 'accept') return normalizedFinalGrade || normalizedSuggestedGrade;
  return normalizedFinalGrade || normalizedSuggestedGrade;
}

decisionRouter.post('/decision', async (req, res) => {
  const userId = req.user?.id ?? null;
  if (!userId) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Authentication required.'
    });
  }

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
      issue: "Must be one of: 'accept', 'correct-again', 'correct-hard', 'correct-good', 'correct-easy', 'uncertain'."
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
      issue: "Must be one of: 'AGAIN', 'HARD', 'GOOD', 'EASY'."
    });
  }

  if (!ALLOWED_FINAL_GRADES.has(finalGrade)) {
    validationErrors.push({
      field: 'final_grade',
      issue: "Must resolve to one of: 'again', 'hard', 'good', 'easy'."
    });
  }

  if (typeof acceptedSuggestion !== 'boolean') {
    validationErrors.push({
      field: 'accepted_suggestion',
      issue: 'Must be a boolean.'
    });
  }


  if ((CORRECTION_ACTIONS.has(action) || action === 'uncertain') && correctionReason.length < 5) {
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

  if (CORRECTION_ACTIONS.has(action) && acceptedSuggestion !== false) {
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
      AND user_id = $2
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
      AND ei.user_id = $9
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
    modelConfidence,
    userId
  ];

  let client;

  try {
    client = await dbPool.connect();
    await client.query('BEGIN');

    const resolvedItem = evaluationId
      ? await client.query(resolveByEvaluationIdQuery, [evaluationId, userId])
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
        decided_at,
        user_id
      )
      VALUES ($1, $2, $3, $4, NOW(), $5)
      RETURNING id, evaluation_item_id, final_grade, decision_type, reason, decided_at
    `;

    const insertValues = [
      evaluationItemId,
      finalGrade,
      toDecisionType(action),
      correctionReason || null,
      userId
    ];

    const insertResult = await client.query(insertQuery, insertValues);
    await client.query('COMMIT');

    const decision = insertResult.rows[0];

    // Log to activity_log for heatmap (best-effort)
    dbPool.query(
      `INSERT INTO activity_log (activity_type, subject, grade, user_id) VALUES ('evaluate', $1, $2, $3)`,
      [inputSubject || null, finalGrade, userId]
    ).catch((e) => console.warn('[activity log]', e.message));

    // Bridge: keep scheduler in sync (best-effort, non-blocking)
    if (action !== 'uncertain' && inputPrompt && inputExpectedAnswer && ALLOWED_FINAL_GRADES.has(finalGrade)) {
      syncSchedulerCard(dbPool, {
        prompt_text: inputPrompt,
        expected_answer_text: inputExpectedAnswer,
        subject: inputSubject || null,
        final_grade: finalGrade,
        evaluation_item_id: evaluationItemId,
        user_id: userId,
        decision_action: action
      }).catch((e) => console.warn('[scheduler sync] failed (non-blocking):', e.message));
    }

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



/**
 * Upsert a card into the scheduler and apply SM-2 based on the decision grade.
 * If FAIL and concept gaps exist, generate micro-cards for missing concepts.
 * If PASS, archive any active micro-cards for that card.
 */
async function syncSchedulerCard(pool, {
  prompt_text,
  expected_answer_text,
  subject,
  final_grade,
  evaluation_item_id,
  user_id,
  decision_action
}) {
  const microMatch = await pool.query(
    `SELECT mc.*
     FROM micro_cards mc
     WHERE mc.user_id = $1
       AND mc.status = 'active'
       AND mc.question = $2
     ORDER BY
       CASE WHEN mc.expected_answer = $3 THEN 0 ELSE 1 END,
       mc.id DESC
     LIMIT 1`,
    [user_id, prompt_text, expected_answer_text]
  );

  if (microMatch.rows.length) {
    const micro = microMatch.rows[0];
    const schedule = computeNextReview(
      parseFloat(micro.interval_days),
      parseFloat(micro.ease_factor),
      final_grade
    );

    // Archive immediately on any pass-grade (good/easy)
    const nextStatus = isPassGrade(final_grade) ? 'archived' : micro.status;

    await pool.query(
      `UPDATE micro_cards
       SET interval_days = $1, ease_factor = $2, next_review_at = $3,
           status = $4, review_count = review_count + 1, updated_at = now()
       WHERE id = $5`,
      [schedule.interval_days, schedule.ease_factor, schedule.next_review_at, nextStatus, micro.id]
    );

    return;
  }


  // Safety rail: micro-cards never spawn new micro-cards.
  // If the prompt belongs to any historical micro-card, stop the scheduler sync here.
  const historicalMicroMatch = await pool.query(
    `SELECT id
     FROM micro_cards
     WHERE user_id = $1
       AND question = $2
     ORDER BY id DESC
     LIMIT 1`,
    [user_id, prompt_text]
  );

  if (historicalMicroMatch.rows.length) {
    return;
  }

  // Find or create the card
  const existing = await pool.query(
    `SELECT *
       FROM cards
      WHERE user_id = $1
        AND prompt_text = $2
        AND expected_answer_text = $3
        AND archived_at IS NULL
      LIMIT 1`,
    [user_id, prompt_text, expected_answer_text]
  );

  let card;
  if (existing.rows.length) {
    card = existing.rows[0];
    // Update subject if it was missing before
    if (subject && !card.subject) {
      await pool.query('UPDATE cards SET subject = $1, updated_at = now() WHERE id = $2', [subject, card.id]);
      card.subject = subject;
    }
  } else {
    const inserted = await pool.query(
      `INSERT INTO cards (subject, prompt_text, expected_answer_text, user_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [subject, prompt_text, expected_answer_text, user_id]
    );
    card = inserted.rows[0];
  }

  // Apply SM-2
  const schedule = computeNextReview(
    parseFloat(card.interval_days),
    parseFloat(card.ease_factor),
    final_grade
  );

  await pool.query(
    `UPDATE cards
     SET interval_days = $1, ease_factor = $2, next_review_at = $3,
         review_count = review_count + 1,
         pass_count   = pass_count + $4,
         last_reviewed_at = now(),
         updated_at = now()
     WHERE id = $5`,
    [schedule.interval_days, schedule.ease_factor, schedule.next_review_at,
     isPassGrade(final_grade) ? 1 : 0, card.id]
  );

  if (isPassGrade(final_grade)) {
    // Full understanding confirmed — retire active micro-cards
    await pool.query(
      `UPDATE micro_cards SET status = 'archived', updated_at = now()
       WHERE parent_card_id = $1 AND status = 'active'`,
      [card.id]
    );
  }

  // Fetch concept gaps stored at evaluation time (limited — only top-N needed).
  const { rows: gaps } = await pool.query(
    'SELECT concept FROM concept_gaps WHERE evaluation_item_id = $1 ORDER BY created_at DESC LIMIT 10',
    [evaluation_item_id]
  );
  // Don't create micros when teacher explicitly corrected to a pass grade
  const isManualPassCorrection = isPassGrade(final_grade) &&
    ['correct-pass', 'correct-good', 'correct-easy'].includes(decision_action);
  const shouldCreateMicros = !isManualPassCorrection;
  const targetGaps = shouldCreateMicros
    ? pickTopGap(gaps)
    : [];

  for (const { concept } of targetGaps) {
    if (!concept) continue;

    try {
      let micro;
      try {
        micro = await generateMicroCard({
          prompt_text: card.prompt_text,
          expected_answer_text: card.expected_answer_text,
          subject: card.subject,
          concept
        });
      } catch (generationError) {
        console.warn(`[scheduler sync] micro-card gen failed for "${concept}", using fallback:`, generationError.message);
        micro = {
          question: `¿Qué es "${concept}" y por qué es importante?`,
          expected_answer: card.expected_answer_text || card.expected_answer || concept
        };
      }

      const result = await pool.query(
        `INSERT INTO micro_cards (parent_card_id, concept, question, expected_answer, user_id, subject)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (parent_card_id, concept) DO NOTHING`,
        [card.id, concept, micro.question, micro.expected_answer, user_id, card.subject || null]
      );
      if (result.rowCount > 0) {
        console.info(`[scheduler sync] micro-card created for concept "${concept}" (card ${card.id})`);
      } else {
        console.info(`[scheduler sync] micro-card skipped — already active for card ${card.id}`);
      }
    } catch (e) {
      console.warn(`[scheduler sync] micro-card persist failed for "${concept}":`, e.message);
    }
  }
}

decisionRouter.get('/decision/audit/latest', async (req, res) => {
  const rawLimit = Number.parseInt(normalizeString(req.query.limit), 10);
  const limit = Number.isNaN(rawLimit) ? 100 : Math.min(Math.max(rawLimit, 1), 100);
  const userId = req.user.id;

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
    WHERE ei.user_id = $2
    ORDER BY es.created_at DESC
    LIMIT $1
  `;

  try {
    const { rows } = await dbPool.query(latestSignalsQuery, [limit, userId]);

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
