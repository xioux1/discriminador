import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { findDuplicatedSessionItems, planSession } from '../services/session-planner.js';

const sessionPlannerRouter = Router();

function estimateRetention(card) {
  const lastReviewed = card.last_reviewed_at ? new Date(card.last_reviewed_at) : null;
  if (!lastReviewed) return null; // never reviewed — treat as new, not forgotten
  const daysSince = (Date.now() - lastReviewed.getTime()) / 86400000;
  const stability = parseFloat(card.stability) || 1;
  return Math.pow(0.9, daysSince / stability);
}

// Max days we can safely push next_review_at before retention drops below floor.
function maxSafeDeferDays(card, floor) {
  const lastReviewed = card.last_reviewed_at ? new Date(card.last_reviewed_at) : null;
  if (!lastReviewed) return 0;
  const daysSince = (Date.now() - lastReviewed.getTime()) / 86400000;
  const stability = parseFloat(card.stability) || 1;
  // R = 0.9^(d/S) >= floor  →  d <= S * log(floor)/log(0.9)
  const maxTotal = stability * (Math.log(floor) / Math.log(0.9));
  return Math.max(0, Math.min(14, Math.floor(maxTotal - daysSince)));
}

// POST /session/plan
sessionPlannerRouter.post('/session/plan', async (req, res) => {
  const { available_minutes, energy_level } = req.body || {};
  const normalizedSubject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const subjectFilter = normalizedSubject || null;

  if (
    available_minutes === undefined ||
    available_minutes === null ||
    typeof available_minutes !== 'number' ||
    !Number.isFinite(available_minutes) ||
    available_minutes < 5 ||
    available_minutes > 120
  ) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'available_minutes debe ser un número entre 5 y 120.'
    });
  }

  if (!['tired', 'normal', 'focused'].includes(energy_level)) {
    return res.status(422).json({
      error: 'validation_error',
      message: "energy_level debe ser 'tired', 'normal' o 'focused'."
    });
  }

  const userId = req.user.id;

  try {
    // 1. Fetch overdue micro-cards (include FSRS stability + last_reviewed_at)
    const microParams = [userId];
    if (subjectFilter) microParams.push(subjectFilter);
    const microSubjectSql = subjectFilter ? `AND c.subject = $${microParams.length}` : '';

    const microResult = await dbPool.query(
      `SELECT mc.id, mc.concept, mc.parent_card_id, mc.question, mc.expected_answer,
              mc.interval_days, mc.ease_factor, mc.next_review_at, mc.review_count,
              mc.status, mc.created_at, mc.stability, mc.last_reviewed_at,
              c.subject AS parent_subject,
              c.avg_response_time_ms AS parent_avg_response_time_ms,
              c.prompt_text AS parent_prompt,
              c.expected_answer_text AS parent_expected
       FROM micro_cards mc
       JOIN cards c ON mc.parent_card_id = c.id
       WHERE mc.status = 'active'
         AND mc.next_review_at <= now()
         AND mc.user_id = $1
         AND mc.flagged = FALSE
         ${microSubjectSql}
       ORDER BY mc.next_review_at ASC
       LIMIT 30`,
      microParams
    );

    // 2. Fetch overdue cards (include FSRS stability + last_reviewed_at)
    const cardsParams = [userId];
    if (subjectFilter) cardsParams.push(subjectFilter);
    const cardsSubjectSql = subjectFilter ? `AND c.subject = $${cardsParams.length}` : '';

    const cardsResult = await dbPool.query(
      `SELECT c.id, c.subject, c.prompt_text, c.expected_answer_text,
              c.interval_days, c.ease_factor, c.next_review_at,
              c.pass_count, c.review_count, c.avg_response_time_ms,
              c.stability, c.last_reviewed_at,
              COUNT(mc.id) FILTER (WHERE mc.status = 'active') AS active_micro_count
       FROM cards c
       LEFT JOIN micro_cards mc ON mc.parent_card_id = c.id
       WHERE c.next_review_at <= now()
         AND c.user_id = $1
         AND c.flagged = FALSE
         AND c.archived_at IS NULL
         AND c.suspended_at IS NULL
         ${cardsSubjectSql}
       GROUP BY c.id
       ORDER BY c.next_review_at ASC
       LIMIT 30`,
      cardsParams
    );

    const cards      = cardsResult.rows;
    const microCards = microResult.rows;

    const duplicatedItems = findDuplicatedSessionItems(cards, microCards);
    if (duplicatedItems.length > 0) {
      return res.status(422).json({
        error: 'validation_error',
        message: 'La sesión actual contiene tarjetas o microconsignas duplicadas.',
        duplicates: duplicatedItems
      });
    }

    // 3. Collect distinct subjects
    const subjects = new Set();
    for (const c of cards)      if (c.subject)        subjects.add(c.subject);
    for (const m of microCards) if (m.parent_subject) subjects.add(m.parent_subject);

    let subjectConfigs = [];
    let retentionFloors = {};

    if (subjects.size > 0) {
      const subjectList = Array.from(subjects);

      const [examDatesResult, retentionResult] = await Promise.all([
        dbPool.query(
          `SELECT DISTINCT ON (subject)
                  subject, exam_date, exam_type, scope_pct, label
           FROM subject_exam_dates
           WHERE subject = ANY($1::text[])
             AND user_id = $2
             AND exam_date >= CURRENT_DATE
           ORDER BY subject, exam_date ASC`,
          [subjectList, userId]
        ),
        dbPool.query(
          `SELECT subject, retention_floor
           FROM subject_configs
           WHERE user_id = $1 AND subject = ANY($2::text[])`,
          [userId, subjectList]
        )
      ]);

      retentionFloors = Object.fromEntries(
        retentionResult.rows.map((r) => [r.subject, parseFloat(r.retention_floor) || 0.75])
      );

      const coveredSubjects = new Set(examDatesResult.rows.map((r) => r.subject));
      const legacySubjects  = subjectList.filter((s) => !coveredSubjects.has(s));

      let legacyRows = [];
      if (legacySubjects.length > 0) {
        const cfgResult = await dbPool.query(
          `SELECT subject, exam_date, exam_type, 50 AS scope_pct
           FROM subject_configs
           WHERE subject = ANY($1::text[])`,
          [legacySubjects]
        );
        legacyRows = cfgResult.rows;
      }

      subjectConfigs = [...examDatesResult.rows, ...legacyRows];
    }

    // 4. Annotate cards with estimated retention + forced flag + max safe defer days
    for (const c of cards) {
      c.estimated_retention = estimateRetention(c);
      const floor = retentionFloors[c.subject] ?? 0.75;
      c.retention_forced  = c.estimated_retention !== null && c.estimated_retention < floor;
      c.retention_floor   = floor;
      c.max_defer_days    = c.retention_forced ? 0 : maxSafeDeferDays(c, floor);
    }
    for (const m of microCards) {
      m.estimated_retention = estimateRetention(m);
      const floor = retentionFloors[m.parent_subject] ?? 0.75;
      m.retention_forced  = m.estimated_retention !== null && m.estimated_retention < floor;
      m.retention_floor   = floor;
      m.max_defer_days    = m.retention_forced ? 0 : maxSafeDeferDays(m, floor);
    }

    // 5. Timing baselines + calibration
    const [avgResult, subjectAvgResult, calibResult] = await Promise.all([
      dbPool.query(
        `SELECT AVG(avg_response_time_ms)::int AS avg_ms
         FROM cards WHERE avg_response_time_ms IS NOT NULL AND user_id = $1`,
        [userId]
      ),
      dbPool.query(
        `SELECT subject, AVG(avg_response_time_ms)::int AS avg_ms
         FROM cards
         WHERE user_id = $1 AND avg_response_time_ms IS NOT NULL AND subject IS NOT NULL
         GROUP BY subject`,
        [userId]
      ),
      dbPool.query(
        `SELECT CASE
           WHEN COUNT(*) >= 3
           THEN GREATEST(0.5, LEAST(2.0,
                  AVG(actual_minutes::numeric / NULLIF(planned_minutes, 0))
                ))::numeric(4,3)
           ELSE 1.0
         END AS calibration_factor
         FROM (
           SELECT actual_minutes, planned_minutes
           FROM study_sessions
           WHERE user_id = $1
             AND actual_minutes IS NOT NULL
             AND planned_minutes > 0
           ORDER BY ended_at DESC
           LIMIT 10
         ) recent`,
        [userId]
      )
    ]);

    const avgResponseTimeMs      = avgResult.rows[0]?.avg_ms ?? null;
    const subjectAvgMsBySubject   = Object.fromEntries(
      subjectAvgResult.rows
        .filter((r) => r.subject && Number.isFinite(Number(r.avg_ms)))
        .map((r) => [r.subject, Number(r.avg_ms)])
    );
    const calibrationFactor = Number(calibResult.rows[0]?.calibration_factor ?? 1.0);

    // 6. Call session planner (agent)
    const plan = await planSession({
      availableMinutes: available_minutes,
      energyLevel: energy_level,
      cards,
      microCards,
      subjectConfigs,
      retentionFloors,
      calibrationFactor,
      avgResponseTimeMs,
      subjectAvgMsBySubject,
    });

    // 7. Apply rescheduling: push next_review_at for deferred non-forced items
    const cardById  = new Map(cards.map((c) => [c.id, c]));
    const microById = new Map(microCards.map((m) => [m.id, m]));
    const rescheduled = [];

    for (const d of plan.deferred) {
      if (!d.defer_days || d.forced) continue;
      const item  = d.type === 'card' ? cardById.get(d.id) : microById.get(d.id);
      if (!item) continue;
      const floor = d.type === 'card'
        ? (retentionFloors[item.subject] ?? 0.75)
        : (retentionFloors[item.parent_subject] ?? 0.75);
      // Safety cap: never defer past the retention floor
      const safeDays  = maxSafeDeferDays(item, floor);
      const deferDays = Math.min(d.defer_days, safeDays);
      if (deferDays < 1) continue;

      const table = d.type === 'card' ? 'cards' : 'micro_cards';
      try {
        await dbPool.query(
          `UPDATE ${table}
           SET next_review_at = now() + $1 * INTERVAL '1 day'
           WHERE id = $2 AND user_id = $3`,
          [deferDays, d.id, userId]
        );
        rescheduled.push({ type: d.type, id: d.id, subject: d.subject, defer_days: deferDays });
      } catch (reschedErr) {
        console.error(`reschedule ${table}#${d.id} failed (non-fatal):`, reschedErr.message);
      }
    }

    // 8. Persist agent reasoning log
    const forcedCount = [...cards, ...microCards].filter((x) => x.retention_forced).length;
    try {
      await dbPool.query(
        `INSERT INTO session_plan_logs
           (user_id, available_minutes, energy_level, subject_filter,
            planned_count, deferred_count, forced_count, agent_reasoning, card_decisions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          userId,
          available_minutes,
          energy_level,
          subjectFilter,
          plan.planned.length,
          plan.deferred.length,
          forcedCount,
          plan.agent_log || '',
          JSON.stringify(plan.card_decisions || [])
        ]
      );
    } catch (logErr) {
      console.error('session_plan_logs insert failed (non-fatal):', logErr.message);
    }

    return res.status(200).json({
      plan: { ...plan, rescheduled },
      cards,
      micro_cards: microCards
    });
  } catch (err) {
    console.error('POST /session/plan', err.stack || err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /session/plan-logs
// Returns the last N agent reasoning logs for the authenticated user.
sessionPlannerRouter.get('/session/plan-logs', async (req, res) => {
  const userId = req.user.id;
  const limit  = Math.min(50, Math.max(1, parseInt(req.query.limit) || 10));

  try {
    const result = await dbPool.query(
      `SELECT id, available_minutes, energy_level, subject_filter,
              planned_count, deferred_count, forced_count,
              agent_reasoning, card_decisions, created_at
       FROM session_plan_logs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit]
    );
    return res.json({ logs: result.rows });
  } catch (err) {
    console.error('GET /session/plan-logs', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default sessionPlannerRouter;
