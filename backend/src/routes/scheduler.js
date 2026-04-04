import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { computeNextReview, MICRO_MASTERY_THRESHOLD_DAYS } from '../services/scheduler.js';
import { generateMicroCard } from '../services/micro-generator.js';

const schedulerRouter = Router();

// ─── Register / upsert a card ─────────────────────────────────────────────────
schedulerRouter.post('/scheduler/cards', async (req, res) => {
  const { subject, prompt_text, expected_answer_text } = req.body || {};

  if (!prompt_text?.trim() || !expected_answer_text?.trim()) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'prompt_text and expected_answer_text are required.'
    });
  }

  try {
    const result = await dbPool.query(
      `INSERT INTO cards (subject, prompt_text, expected_answer_text)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [subject?.trim() || null, prompt_text.trim(), expected_answer_text.trim()]
    );
    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('scheduler POST /cards', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ─── List all cards ───────────────────────────────────────────────────────────
schedulerRouter.get('/scheduler/cards', async (req, res) => {
  const { subject } = req.query;

  try {
    const result = await dbPool.query(
      `SELECT c.*,
         COUNT(mc.id) FILTER (WHERE mc.status = 'active') AS active_micro_count
       FROM cards c
       LEFT JOIN micro_cards mc ON mc.parent_card_id = c.id
       ${subject ? 'WHERE c.subject = $1' : ''}
       GROUP BY c.id
       ORDER BY c.next_review_at ASC`,
      subject ? [subject] : []
    );
    return res.status(200).json({ cards: result.rows });
  } catch (err) {
    console.error('scheduler GET /cards', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ─── Today's session queue ────────────────────────────────────────────────────
// Micro-cards are always returned first (remediation before new material).
// Full cards with active micros are flagged with has_pending_micros = true
// (soft block: they appear but with a warning).
schedulerRouter.get('/scheduler/session', async (req, res) => {
  const { subject } = req.query;
  const subjectFilter = subject ? 'AND c.subject = $1' : '';
  const params = subject ? [subject] : [];

  try {
    const microResult = await dbPool.query(
      `SELECT mc.*,
         c.subject           AS parent_subject,
         c.prompt_text       AS parent_prompt,
         c.expected_answer_text AS parent_expected
       FROM micro_cards mc
       JOIN cards c ON mc.parent_card_id = c.id
       WHERE mc.status = 'active'
         AND mc.next_review_at <= now()
         ${subjectFilter}
       ORDER BY mc.next_review_at ASC
       LIMIT 30`,
      params
    );

    const cardsResult = await dbPool.query(
      `SELECT c.*,
         COUNT(mc.id) FILTER (WHERE mc.status = 'active') AS active_micro_count
       FROM cards c
       LEFT JOIN micro_cards mc ON mc.parent_card_id = c.id
       WHERE c.next_review_at <= now()
         ${subjectFilter}
       GROUP BY c.id
       ORDER BY
         COUNT(mc.id) FILTER (WHERE mc.status = 'active') ASC,  -- unblocked first
         c.next_review_at ASC
       LIMIT 30`,
      params
    );

    const totalDue = microResult.rows.length + cardsResult.rows.length;

    return res.status(200).json({
      total_due: totalDue,
      micro_cards: microResult.rows,
      cards: cardsResult.rows
    });
  } catch (err) {
    console.error('scheduler GET /session', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ─── Record a review result ───────────────────────────────────────────────────
// Body: { card_id?, micro_card_id?, grade, concept_gaps?, response_time_ms? }
// grade='review' is treated as 'fail' for scheduling purposes.
schedulerRouter.post('/scheduler/review', async (req, res) => {
  const { card_id, micro_card_id, grade, concept_gaps = [], response_time_ms } = req.body || {};

  if (!grade || !['pass', 'fail', 'review'].includes(grade.toLowerCase())) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'grade must be pass, fail, or review.'
    });
  }

  const effectiveGrade = grade.toLowerCase() === 'review' ? 'fail' : grade.toLowerCase();

  // Log activity (best-effort)
  const rtMs = Number.isFinite(Number(response_time_ms)) ? Number(response_time_ms) : null;

  try {
    if (micro_card_id) {
      return await reviewMicroCard(res, Number(micro_card_id), effectiveGrade, rtMs);
    } else if (card_id) {
      return await reviewCard(res, Number(card_id), effectiveGrade, concept_gaps, rtMs);
    }
    return res.status(422).json({
      error: 'validation_error',
      message: 'card_id or micro_card_id is required.'
    });
  } catch (err) {
    console.error('scheduler POST /review', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ─── Internal: review a full card ────────────────────────────────────────────
async function reviewCard(res, cardId, grade, conceptGaps, responseTimeMs) {
  const { rows } = await dbPool.query('SELECT * FROM cards WHERE id = $1', [cardId]);
  if (!rows.length) {
    return res.status(404).json({ error: 'not_found', message: 'Card not found.' });
  }

  const card = rows[0];
  const schedule = computeNextReview(
    parseFloat(card.interval_days),
    parseFloat(card.ease_factor),
    grade
  );

  const updated = await dbPool.query(
    `UPDATE cards
     SET interval_days = $1, ease_factor = $2, next_review_at = $3,
         review_count = review_count + 1,
         pass_count   = pass_count + $4,
         avg_response_time_ms = CASE WHEN $5::int IS NOT NULL THEN
           COALESCE(ROUND((COALESCE(avg_response_time_ms, $5::int) + $5::int) / 2.0), $5::int)
           ELSE avg_response_time_ms END,
         last_reviewed_at = now(),
         updated_at = now()
     WHERE id = $6
     RETURNING *`,
    [schedule.interval_days, schedule.ease_factor, schedule.next_review_at,
     grade === 'pass' ? 1 : 0, responseTimeMs, cardId]
  );

  // Log activity
  dbPool.query(
    `INSERT INTO activity_log (activity_type, subject, grade, response_time_ms)
     VALUES ('study', $1, $2, $3)`,
    [updated.rows[0]?.subject || null, grade, responseTimeMs]
  ).catch((e) => console.warn('[activity log]', e.message));

  let newMicroCards = [];

  if (grade === 'pass') {
    // Archive all active micro-cards — the student demonstrated full understanding.
    await dbPool.query(
      `UPDATE micro_cards SET status = 'archived', updated_at = now()
       WHERE parent_card_id = $1 AND status = 'active'`,
      [cardId]
    );
  } else if (conceptGaps.length > 0) {
    // LLM already ranked the gaps by importance (index 0 = root concept).
    // Only generate one micro-card per concept that isn't already active.
    for (const concept of conceptGaps) {
      const existing = await dbPool.query(
        `SELECT id FROM micro_cards
         WHERE parent_card_id = $1 AND concept = $2 AND status = 'active'`,
        [cardId, concept]
      );
      if (existing.rows.length) continue;

      try {
        const micro = await generateMicroCard({
          prompt_text: card.prompt_text,
          expected_answer_text: card.expected_answer_text,
          subject: card.subject,
          concept
        });

        const inserted = await dbPool.query(
          `INSERT INTO micro_cards (parent_card_id, concept, question, expected_answer)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [cardId, concept, micro.question, micro.expected_answer]
        );
        newMicroCards.push(inserted.rows[0]);
      } catch (microErr) {
        console.warn(`Failed to generate micro-card for concept "${concept}":`, microErr.message);
      }
    }
  }

  return res.status(200).json({
    card: updated.rows[0],
    new_micro_cards: newMicroCards
  });
}

// ─── Internal: review a micro-card ───────────────────────────────────────────
async function reviewMicroCard(res, microCardId, grade, responseTimeMs) {
  const { rows } = await dbPool.query('SELECT * FROM micro_cards WHERE id = $1', [microCardId]);
  if (!rows.length) {
    return res.status(404).json({ error: 'not_found', message: 'Micro-card not found.' });
  }

  const micro = rows[0];
  const schedule = computeNextReview(
    parseFloat(micro.interval_days),
    parseFloat(micro.ease_factor),
    grade
  );

  // Archive when mastery threshold is reached.
  const newStatus =
    grade === 'pass' && schedule.interval_days >= MICRO_MASTERY_THRESHOLD_DAYS
      ? 'archived'
      : micro.status;

  const updated = await dbPool.query(
    `UPDATE micro_cards
     SET interval_days = $1, ease_factor = $2, next_review_at = $3,
         status = $4, review_count = review_count + 1, updated_at = now()
     WHERE id = $5
     RETURNING *`,
    [schedule.interval_days, schedule.ease_factor, schedule.next_review_at,
     newStatus, microCardId]
  );

  let parentUnblocked = false;

  if (grade === 'pass') {
    // Check remaining active micros for this parent (excluding the one we just updated).
    const { rows: remaining } = await dbPool.query(
      `SELECT COUNT(*) AS cnt FROM micro_cards
       WHERE parent_card_id = $1 AND status = 'active' AND id != $2`,
      [micro.parent_card_id, microCardId]
    );

    if (parseInt(remaining[0].cnt) === 0) {
      // Bring parent back sooner (3 days) if it's far away.
      await dbPool.query(
        `UPDATE cards
         SET next_review_at = LEAST(next_review_at, now() + INTERVAL '3 days'),
             updated_at = now()
         WHERE id = $1`,
        [micro.parent_card_id]
      );
      parentUnblocked = true;
    }
  }

  // Log activity
  dbPool.query(
    `INSERT INTO activity_log (activity_type, subject, grade, response_time_ms)
     VALUES ('study', $1, $2, $3)`,
    [micro.parent_subject || null, grade, responseTimeMs]
  ).catch((e) => console.warn('[activity log]', e.message));

  return res.status(200).json({
    micro_card: updated.rows[0],
    parent_unblocked: parentUnblocked
  });
}

// ─── Agenda: full schedule view ──────────────────────────────────────────────
// Returns all cards + their micro-cards, grouped into time buckets.
schedulerRouter.get('/scheduler/agenda', async (req, res) => {
  const { subject } = req.query;
  const subjectFilter = subject ? 'WHERE c.subject = $1' : '';
  const params = subject ? [subject] : [];

  try {
    const { rows: cards } = await dbPool.query(
      `SELECT c.*,
         json_agg(
           json_build_object(
             'id',             mc.id,
             'concept',        mc.concept,
             'question',       mc.question,
             'next_review_at', mc.next_review_at,
             'interval_days',  mc.interval_days,
             'ease_factor',    mc.ease_factor,
             'review_count',   mc.review_count,
             'status',         mc.status
           ) ORDER BY mc.next_review_at
         ) FILTER (WHERE mc.id IS NOT NULL AND mc.status = 'active') AS micro_cards
       FROM cards c
       LEFT JOIN micro_cards mc ON mc.parent_card_id = c.id AND mc.status = 'active'
       ${subjectFilter}
       GROUP BY c.id
       ORDER BY c.next_review_at ASC`,
      params
    );

    // Assign each card to a time bucket
    const now   = new Date();
    const eod   = new Date(now); eod.setHours(23, 59, 59, 999);
    const eotom = new Date(now); eotom.setDate(eotom.getDate() + 1); eotom.setHours(23, 59, 59, 999);
    const eow   = new Date(now); eow.setDate(eow.getDate() + 7);
    const eo2w  = new Date(now); eo2w.setDate(eo2w.getDate() + 14);

    const buckets = {
      overdue:    [],
      today:      [],
      tomorrow:   [],
      this_week:  [],
      two_weeks:  [],
      later:      []
    };

    for (const card of cards) {
      card.micro_cards = card.micro_cards ?? [];
      const due = new Date(card.next_review_at);
      if      (due < now)    buckets.overdue.push(card);
      else if (due <= eod)   buckets.today.push(card);
      else if (due <= eotom) buckets.tomorrow.push(card);
      else if (due <= eow)   buckets.this_week.push(card);
      else if (due <= eo2w)  buckets.two_weeks.push(card);
      else                   buckets.later.push(card);
    }

    return res.status(200).json({
      generated_at: now.toISOString(),
      summary: {
        total_cards:      cards.length,
        overdue:          buckets.overdue.length,
        due_today:        buckets.today.length,
        due_tomorrow:     buckets.tomorrow.length,
        due_this_week:    buckets.this_week.length,
        due_two_weeks:    buckets.two_weeks.length,
        due_later:        buckets.later.length,
        active_micro_cards: cards.reduce((n, c) => n + (c.micro_cards?.length ?? 0), 0)
      },
      buckets
    });
  } catch (err) {
    console.error('scheduler GET /agenda', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default schedulerRouter;
