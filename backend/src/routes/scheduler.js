import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { computeNextReview, isPassGrade } from '../services/scheduler.js';
import { generateMicroCard } from '../services/micro-generator.js';
import { generateVariant } from '../services/variant-generator.js';

const schedulerRouter = Router();

function pickTopConcept(concepts = []) {
  return concepts.find((concept) => typeof concept === 'string' && concept.trim().length > 0)?.trim() || null;
}

// ─── Register / upsert a card ─────────────────────────────────────────────────
schedulerRouter.post('/scheduler/cards', async (req, res) => {
  const { subject, prompt_text, expected_answer_text } = req.body || {};
  const userId = req.user.id;
  const normalizedSubject = subject?.trim() || null;

  if (!prompt_text?.trim() || !expected_answer_text?.trim()) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'prompt_text and expected_answer_text are required.'
    });
  }

  try {
    let releaseAt = null;
    if (normalizedSubject) {
      const configResult = await dbPool.query(
        `SELECT daily_new_cards_limit
         FROM subject_configs
         WHERE subject = $1 AND user_id = $2
         LIMIT 1`,
        [normalizedSubject, userId]
      );
      const dailyLimit = Number(configResult.rows[0]?.daily_new_cards_limit);
      if (Number.isFinite(dailyLimit) && dailyLimit > 0) {
        releaseAt = await computeNewCardReleaseAt(userId, normalizedSubject, dailyLimit);
      }
    }

    const result = await dbPool.query(
      `INSERT INTO cards (subject, prompt_text, expected_answer_text, user_id, next_review_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, now()))
       RETURNING *`,
      [normalizedSubject, prompt_text.trim(), expected_answer_text.trim(), userId, releaseAt]
    );
    return res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('scheduler POST /cards', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});


async function computeNewCardReleaseAt(userId, subject, dailyLimit) {
  const { rows } = await dbPool.query(
    `SELECT (next_review_at AT TIME ZONE 'UTC')::date AS release_day,
            COUNT(*)::int AS total
       FROM cards
      WHERE user_id = $1
        AND subject = $2
        AND archived_at IS NULL
        AND suspended_at IS NULL
        AND review_count = 0
        AND next_review_at::date >= current_date
      GROUP BY 1`,
    [userId, subject]
  );

  const byDay = new Map(rows.map((r) => [String(r.release_day).slice(0, 10), Number(r.total)]));
  for (let offset = 0; offset < 3650; offset++) {
    const slot = new Date();
    slot.setUTCHours(0, 0, 0, 0);
    slot.setUTCDate(slot.getUTCDate() + offset);
    const key = slot.toISOString().slice(0, 10);
    const used = byDay.get(key) || 0;
    if (used < dailyLimit) {
      if (offset === 0) return new Date();
      return slot;
    }
  }

  return null;
}

// ─── List all cards ───────────────────────────────────────────────────────────
schedulerRouter.get('/scheduler/cards', async (req, res) => {
  const { subject } = req.query;
  const userId = req.user.id;

  try {
    const params = [userId];
    if (subject) params.push(subject);
    const result = await dbPool.query(
      `SELECT c.*,
         COUNT(mc.id) FILTER (WHERE mc.status = 'active') AS active_micro_count
       FROM cards c
       LEFT JOIN micro_cards mc ON mc.parent_card_id = c.id
       WHERE c.user_id = $1
       AND c.archived_at IS NULL
       AND c.suspended_at IS NULL
       ${subject ? 'AND c.subject = $2' : ''}
       GROUP BY c.id
       ORDER BY c.next_review_at ASC`,
      params
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
  const userId = req.user.id;
  const params = [userId];
  if (subject) params.push(subject);
  const subjectFilter = subject ? `AND c.subject = $${params.length}` : '';

  try {
    const microResult = await dbPool.query(
      `SELECT mc.*,
         c.subject           AS parent_subject,
         c.prompt_text       AS parent_prompt,
         c.expected_answer_text AS parent_expected
       FROM micro_cards mc
       JOIN cards c ON mc.parent_card_id = c.id
       WHERE mc.status = 'active'
         AND c.archived_at IS NULL
         AND c.suspended_at IS NULL
         AND mc.next_review_at <= now()
         AND mc.user_id = $1
         ${subjectFilter}
       ORDER BY mc.next_review_at ASC
       LIMIT 30`,
      params
    );

    const cardsResult = await dbPool.query(
      `SELECT c.*,
         COUNT(mc.id) FILTER (WHERE mc.status = 'active') AS active_micro_count,
         COUNT(cv.id) AS variant_count
       FROM cards c
       LEFT JOIN micro_cards mc ON mc.parent_card_id = c.id
       LEFT JOIN card_variants cv ON cv.card_id = c.id
       WHERE c.next_review_at <= now()
         AND c.archived_at IS NULL
         AND c.suspended_at IS NULL
         AND c.user_id = $1
         ${subjectFilter}
       GROUP BY c.id
       ORDER BY
         COUNT(mc.id) FILTER (WHERE mc.status = 'active') ASC,
         c.next_review_at ASC
       LIMIT 30`,
      params
    );

    // For each card that has variants, randomly pick one to show
    // (50% chance to use a variant; always use original if no variants exist)
    const cards = await Promise.all(cardsResult.rows.map(async (card) => {
      if (parseInt(card.variant_count) > 0 && Math.random() < 0.5) {
        const vRes = await dbPool.query(
          `SELECT * FROM card_variants WHERE card_id = $1 ORDER BY random() LIMIT 1`,
          [card.id]
        );
        if (vRes.rows.length > 0) {
          const v = vRes.rows[0];
          return {
            ...card,
            prompt_text: v.prompt_text,
            expected_answer_text: v.expected_answer_text,
            variant_id: v.id
          };
        }
      }
      return card;
    }));

    const totalDue = microResult.rows.length + cards.length;

    return res.status(200).json({
      total_due: totalDue,
      micro_cards: microResult.rows,
      cards
    });
  } catch (err) {
    console.error('scheduler GET /session', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ─── Record a review result ───────────────────────────────────────────────────
// Body: { card_id?, micro_card_id?, grade, concept_gaps?, response_time_ms? }
// Accepted grades: again|hard|good|easy (+ legacy pass|fail|review)
schedulerRouter.post('/scheduler/review', async (req, res) => {
  const { card_id, micro_card_id, grade, concept_gaps = [], response_time_ms, user_answer = '' } = req.body || {};
  const userId = req.user.id;

  const VALID_GRADES = new Set(['pass', 'fail', 'review', 'again', 'hard', 'good', 'easy']);
  if (!grade || !VALID_GRADES.has(grade.toLowerCase())) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'grade must be again, hard, good, or easy.'
    });
  }

  // Normalize: legacy 'review' → 'hard'; everything else passed through
  const effectiveGrade = grade.toLowerCase() === 'review' ? 'hard' : grade.toLowerCase();

  // Log activity (best-effort)
  const rtMs = Number.isFinite(Number(response_time_ms)) ? Number(response_time_ms) : null;

  try {
    if (micro_card_id) {
      return await reviewMicroCard(res, Number(micro_card_id), effectiveGrade, rtMs, userId);
    } else if (card_id) {
      return await reviewCard(res, Number(card_id), effectiveGrade, concept_gaps, rtMs, userId, user_answer);
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
async function reviewCard(res, cardId, grade, conceptGaps, responseTimeMs, userId, userAnswer = '') {
  const { rows } = await dbPool.query(
    'SELECT * FROM cards WHERE id = $1 AND user_id = $2 AND archived_at IS NULL AND suspended_at IS NULL',
    [cardId, userId]
  );
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
     isPassGrade(grade) ? 1 : 0, responseTimeMs, cardId]
  );

  // Log activity (logged_date uses Argentina local date)
  dbPool.query(
    `INSERT INTO activity_log (activity_type, subject, grade, response_time_ms, user_id, logged_date)
     VALUES ('study', $1, $2, $3, $4, (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE)`,
    [updated.rows[0]?.subject || null, grade, responseTimeMs, userId]
  ).catch((e) => console.warn('[activity log]', e.message));

  let newMicroCards = [];

  if (isPassGrade(grade)) {
    // Archive all active micro-cards — the student demonstrated full understanding.
    await dbPool.query(
      `UPDATE micro_cards SET status = 'archived', updated_at = now()
       WHERE parent_card_id = $1 AND status = 'active'`,
      [cardId]
    );
  }

  if (conceptGaps.length > 0) {
    // Generate one micro-card (highest-priority concept gap).
    const topConcept = pickTopConcept(conceptGaps);
    const targetConcepts = topConcept ? [topConcept] : [];

    for (const concept of targetConcepts) {
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
          concept,
          user_answer: userAnswer
        });

        const inserted = await dbPool.query(
          `INSERT INTO micro_cards (parent_card_id, concept, question, expected_answer, user_id)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [cardId, concept, micro.question, micro.expected_answer, userId]
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
async function reviewMicroCard(res, microCardId, grade, responseTimeMs, userId) {
  const { rows } = await dbPool.query('SELECT * FROM micro_cards WHERE id = $1 AND user_id = $2', [microCardId, userId]);
  if (!rows.length) {
    return res.status(404).json({ error: 'not_found', message: 'Micro-card not found.' });
  }

  const micro = rows[0];
  const schedule = computeNextReview(
    parseFloat(micro.interval_days),
    parseFloat(micro.ease_factor),
    grade
  );

  // Archive immediately on any pass-grade (good/easy).
  const newStatus = isPassGrade(grade) ? 'archived' : micro.status;

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

  if (isPassGrade(grade)) {
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

  // Log activity (logged_date uses Argentina local date)
  dbPool.query(
    `INSERT INTO activity_log (activity_type, subject, grade, response_time_ms, user_id, logged_date)
     VALUES ('study', $1, $2, $3, $4, (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE)`,
    [micro.parent_subject || null, grade, responseTimeMs, userId]
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
  const userId = req.user.id;
  const params = [userId];
  if (subject) params.push(subject);
  const subjectFilter = subject ? `AND c.subject = $${params.length}` : '';

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
       WHERE c.user_id = $1
       AND c.archived_at IS NULL
       AND c.suspended_at IS NULL
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

// ─── Generate a conservative variant for a card ───────────────────────────────
// POST /scheduler/cards/:id/variant
// Generates one variant via LLM and stores it in card_variants.
// The original card slot in the scheduler is unchanged.
schedulerRouter.post('/scheduler/cards/:id/variant', async (req, res) => {
  const cardId = parseInt(req.params.id);
  const userId = req.user.id;
  if (!cardId) return res.status(422).json({ error: 'validation_error', message: 'Invalid card id.' });

  try {
    const cardRes = await dbPool.query(
      `SELECT id, subject, prompt_text, expected_answer_text
       FROM cards
       WHERE id = $1 AND user_id = $2 AND archived_at IS NULL AND suspended_at IS NULL`,
      [cardId, userId]
    );
    if (!cardRes.rows.length) return res.status(404).json({ error: 'not_found', message: 'Card not found.' });

    const card = cardRes.rows[0];
    const variant = await generateVariant({
      prompt_text:          card.prompt_text,
      expected_answer_text: card.expected_answer_text,
      subject:              card.subject
    });

    const insertRes = await dbPool.query(
      `INSERT INTO card_variants (card_id, prompt_text, expected_answer_text)
       VALUES ($1, $2, $3) RETURNING *`,
      [cardId, variant.prompt_text, variant.expected_answer_text]
    );

    return res.status(200).json({
      variant: insertRes.rows[0],
      card_id: cardId
    });
  } catch (err) {
    console.error('POST /scheduler/cards/:id/variant', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default schedulerRouter;
