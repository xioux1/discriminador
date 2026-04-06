import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { planSession } from '../services/session-planner.js';

const sessionPlannerRouter = Router();

// POST /session/plan
sessionPlannerRouter.post('/session/plan', async (req, res) => {
  const { available_minutes, energy_level } = req.body || {};
  const normalizedSubject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
  const subjectFilter = normalizedSubject || null;

  // Validate available_minutes
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

  // Validate energy_level
  if (!['tired', 'normal', 'focused'].includes(energy_level)) {
    return res.status(422).json({
      error: 'validation_error',
      message: "energy_level debe ser 'tired', 'normal' o 'focused'."
    });
  }

  const userId = req.user.id;

  try {
    // 1. Fetch overdue micro-cards
    const microParams = [userId];
    if (subjectFilter) microParams.push(subjectFilter);
    const microSubjectSql = subjectFilter ? `AND c.subject = $${microParams.length}` : '';

    const microResult = await dbPool.query(
      `SELECT mc.id, mc.concept, mc.parent_card_id, mc.question, mc.expected_answer,
              mc.interval_days, mc.ease_factor, mc.next_review_at, mc.review_count,
              mc.status,
              c.subject AS parent_subject,
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

    // 2. Fetch overdue cards
    const cardsParams = [userId];
    if (subjectFilter) cardsParams.push(subjectFilter);
    const cardsSubjectSql = subjectFilter ? `AND c.subject = $${cardsParams.length}` : '';

    const cardsResult = await dbPool.query(
      `SELECT c.id, c.subject, c.prompt_text, c.expected_answer_text,
              c.interval_days, c.ease_factor, c.next_review_at,
              c.pass_count, c.review_count, c.avg_response_time_ms,
              COUNT(mc.id) FILTER (WHERE mc.status = 'active') AS active_micro_count
       FROM cards c
       LEFT JOIN micro_cards mc ON mc.parent_card_id = c.id
       WHERE c.next_review_at <= now()
         AND c.user_id = $1
         AND c.flagged = FALSE
         ${cardsSubjectSql}
       GROUP BY c.id
       ORDER BY c.next_review_at ASC
       LIMIT 30`,
      cardsParams
    );

    const cards = cardsResult.rows;
    const microCards = microResult.rows;

    // 3. Collect distinct subjects from cards + micro-cards
    const subjects = new Set();
    for (const c of cards) if (c.subject) subjects.add(c.subject);
    for (const m of microCards) if (m.parent_subject) subjects.add(m.parent_subject);

    let subjectConfigs = [];
    if (subjects.size > 0) {
      const subjectList = Array.from(subjects);

      // Prefer subject_exam_dates (next upcoming per subject) over legacy subject_configs
      const examDatesResult = await dbPool.query(
        `SELECT DISTINCT ON (subject)
                subject, exam_date, exam_type, scope_pct, label
         FROM subject_exam_dates
         WHERE subject = ANY($1::text[])
           AND user_id = $2
           AND exam_date >= CURRENT_DATE
         ORDER BY subject, exam_date ASC`,
        [subjectList, userId]
      );

      // For subjects not in new table, fall back to legacy subject_configs
      const coveredSubjects = new Set(examDatesResult.rows.map(r => r.subject));
      const legacySubjects  = subjectList.filter(s => !coveredSubjects.has(s));

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

    // 4. Calculate avg_response_time_ms
    const avgResult = await dbPool.query(
      `SELECT AVG(avg_response_time_ms)::int AS avg_ms
       FROM cards
       WHERE avg_response_time_ms IS NOT NULL`
    );
    const avgResponseTimeMs = avgResult.rows[0]?.avg_ms ?? null;

    // 5. Call session planner
    const plan = await planSession({
      availableMinutes: available_minutes,
      energyLevel: energy_level,
      cards,
      microCards,
      subjectConfigs,
      avgResponseTimeMs
    });

    return res.status(200).json({
      plan,
      cards,
      micro_cards: microCards
    });
  } catch (err) {
    console.error('POST /session/plan', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default sessionPlannerRouter;
