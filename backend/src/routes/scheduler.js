import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { computeNextReview, isPassGrade, isFailGrade } from '../services/scheduler.js';
import { generateMicroCard, generateMicroCardFromCheckError, generateChineseMicroCard, isChineseCard, rankGaps } from '../services/micro-generator.js';
import { generateVariant, buildChineseListeningVariant } from '../services/variant-generator.js';
import Anthropic from '@anthropic-ai/sdk';

const LLM_MODEL = 'claude-haiku-4-5-20251001';
let _aiClient = null;
function getAiClient() {
  if (!_aiClient) _aiClient = new Anthropic();
  return _aiClient;
}

/**
 * Uses the LLM to score each card's relevance to the exam focus prompt.
 * Returns a map: card_id (string) → multiplier (number).
 * high=3.0, medium=1.5, low=0.05 — falls back to 1.0 for all on error.
 */
async function scoreCardsByExamFocus(cards, examFocusPrompt) {
  // Cap at 100 cards to keep the prompt within token limits
  const subset = cards.slice(0, 100);
  const cardList = subset.map((c) => ({
    id: c.id,
    text: String(c.prompt_text || '').slice(0, 120),
  }));

  const userMessage = `TEMAS DEL EXAMEN:\n${examFocusPrompt}\n\nTARJETAS:\n${JSON.stringify(cardList)}`;

  try {
    const response = await getAiClient().messages.create({
      model: LLM_MODEL,
      max_tokens: 1024,
      temperature: 0,
      system: `Sos un asistente de estudio. El estudiante indicó qué temas estarán en su próximo examen.
Tu tarea: para cada tarjeta de la lista, determiná si su contenido es RELEVANTE ("high"), POSIBLEMENTE RELEVANTE ("medium"), o NO RELEVANTE ("low") para los temas del examen.

Respondé ÚNICAMENTE con JSON válido, sin explicaciones:
{"relevance": [{"id": <number>, "level": "high"|"medium"|"low"}, ...]}

Incluí TODAS las tarjetas de la lista. No omitas ninguna.`,
      messages: [{ role: 'user', content: userMessage }],
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '';
    const jsonText = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    const parsed = JSON.parse(jsonText);

    const multiplierMap = {};
    const MULTIPLIERS = { high: 3.0, medium: 1.5, low: 0.05 };
    for (const item of (parsed.relevance || [])) {
      multiplierMap[String(item.id)] = MULTIPLIERS[item.level] ?? 1.0;
    }
    return multiplierMap;
  } catch (_err) {
    // Graceful fallback: treat all cards as equally relevant
    return {};
  }
}

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

// ─── Due counts per subject (for dashboard) ───────────────────────────────────
// GET /scheduler/due-counts — returns per-subject counts of due cards/micros.
// No LIMIT — intended for display only, not for building a study queue.
schedulerRouter.get('/scheduler/due-counts', async (req, res) => {
  const userId = req.user.id;
  try {
    const [cardsRes, microsRes] = await Promise.all([
      dbPool.query(
        `SELECT subject, COUNT(*) AS cnt
         FROM cards
         WHERE user_id = $1
           AND archived_at IS NULL
           AND suspended_at IS NULL
           AND next_review_at <= now()
         GROUP BY subject`,
        [userId]
      ),
      dbPool.query(
        `SELECT c.subject, COUNT(*) AS cnt
         FROM micro_cards mc
         JOIN cards c ON mc.parent_card_id = c.id
         WHERE mc.user_id = $1
           AND mc.status = 'active'
           AND mc.next_review_at <= now()
           AND c.archived_at IS NULL
           AND c.suspended_at IS NULL
         GROUP BY c.subject`,
        [userId]
      )
    ]);
    const cards  = {};
    const micros = {};
    cardsRes.rows.forEach(({ subject, cnt }) => { cards[subject  || '(sin materia)'] = Number(cnt); });
    microsRes.rows.forEach(({ subject, cnt }) => { micros[subject || '(sin materia)'] = Number(cnt); });
    return res.json({ cards, micros });
  } catch (err) {
    console.error('GET /scheduler/due-counts', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

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

    // For each card that has variants, pick uniformly at random from the full
    // pool: [original, variant_1, variant_2, ...].  Every member of the pool
    // has exactly 1/(N+1) probability — the original card gets no special weight.
    const cards = await Promise.all(cardsResult.rows.map(async (card) => {
      if (parseInt(card.variant_count) === 0) return card;

      const vRes = await dbPool.query(
        `SELECT id, prompt_text, expected_answer_text, variant_type FROM card_variants WHERE card_id = $1 AND (user_id = $2 OR user_id IS NULL)`,
        [card.id, card.user_id]
      );
      const variants = vRes.rows;
      if (variants.length === 0) return card;

      // pick = 0 → original; pick ≥ 1 → variants[pick-1]
      const pick = Math.floor(Math.random() * (variants.length + 1));
      if (pick === 0) return card;

      const v = variants[pick - 1];
      return {
        ...card,
        prompt_text:          v.prompt_text,
        expected_answer_text: v.expected_answer_text,
        variant_id:           v.id,
        variant_type:         v.variant_type
      };
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
// Body: { card_id?, micro_card_id?, grade, concept_gaps?, response_time_ms?,
//         review_time_ms?, user_answer?, check_fail_ids? }
// Accepted grades: again|hard|good|easy (+ legacy pass|fail|review)
// check_fail_ids: IDs from binary_check_log for negative in-session checks.
//   When non-empty and final grade is negative, an extra ease penalty applies.
schedulerRouter.post('/scheduler/review', async (req, res) => {
  const { card_id, micro_card_id, grade, concept_gaps = [], response_time_ms, review_time_ms, user_answer = '', check_fail_ids = [] } = req.body || {};
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
  const rtMs  = Number.isFinite(Number(response_time_ms)) ? Number(response_time_ms) : null;
  const rvtMs = Number.isFinite(Number(review_time_ms))   ? Number(review_time_ms)   : null;

  try {
    if (micro_card_id) {
      return await reviewMicroCard(res, Number(micro_card_id), effectiveGrade, concept_gaps, user_answer, rtMs, rvtMs, userId);
    } else if (card_id) {
      const checkFailIds = Array.isArray(check_fail_ids) ? check_fail_ids.map(Number).filter(Boolean) : [];
      return await reviewCard(res, Number(card_id), effectiveGrade, concept_gaps, rtMs, rvtMs, userId, user_answer, checkFailIds);
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

// ─── Background: auto-generate a variant if the subject config requires it ───
async function autoGenerateVariant(cardId, card, userId) {
  const cfgRes = await dbPool.query(
    `SELECT auto_variants_enabled, max_variants_per_card
     FROM subject_configs WHERE subject = $1 AND user_id = $2`,
    [card.subject || '', userId]
  );
  if (!cfgRes.rows[0]?.auto_variants_enabled) return;

  const maxVariants = cfgRes.rows[0].max_variants_per_card; // null = unlimited

  // Count regular and listening variants separately.
  // Listening variants don't count against the regular limit.
  const countRes = await dbPool.query(
    `SELECT variant_type, COUNT(*) AS cnt
     FROM card_variants
     WHERE card_id = $1 AND (user_id = $2 OR user_id IS NULL)
     GROUP BY variant_type`,
    [cardId, userId]
  );
  const variantCounts = {};
  for (const row of countRes.rows) variantCounts[row.variant_type] = parseInt(row.cnt, 10);

  const existingRegular = variantCounts['regular'] || 0;

  if (maxVariants === null || existingRegular < maxVariants) {
    const variant = await generateVariant({
      prompt_text:          card.prompt_text,
      expected_answer_text: card.expected_answer_text,
      subject:              card.subject
    });
    await dbPool.query(
      `INSERT INTO card_variants (card_id, prompt_text, expected_answer_text, user_id, variant_type)
       VALUES ($1, $2, $3, $4, 'regular')`,
      [cardId, variant.prompt_text, variant.expected_answer_text, userId]
    );
    console.info('[auto-variant] generated regular', { cardId, subject: card.subject });
  }

  // For Chinese cards, generate exactly one listening variant (audio-only front).
  if (isChineseCard(card) && !variantCounts['listening']) {
    const lv = buildChineseListeningVariant(card);
    await dbPool.query(
      `INSERT INTO card_variants (card_id, prompt_text, expected_answer_text, user_id, variant_type)
       VALUES ($1, $2, $3, $4, 'listening')`,
      [cardId, lv.prompt_text, lv.expected_answer_text, userId]
    );
    console.info('[auto-variant] generated listening', { cardId, subject: card.subject });
  }
}

// ─── Internal: review a full card ────────────────────────────────────────────
async function reviewCard(res, cardId, grade, conceptGaps, responseTimeMs, reviewTimeMs, userId, userAnswer = '', checkFailIds = []) {
  const checkFailCount = checkFailIds.length;
  const { rows } = await dbPool.query(
    'SELECT * FROM cards WHERE id = $1 AND user_id = $2 AND archived_at IS NULL AND suspended_at IS NULL',
    [cardId, userId]
  );
  if (!rows.length) {
    return res.status(404).json({ error: 'not_found', message: 'Card not found.' });
  }

  const card = rows[0];
  let schedule = computeNextReview({
    stability:     parseFloat(card.stability),
    difficulty:    parseFloat(card.difficulty),
    lastReviewedAt: card.last_reviewed_at,
    grade,
    isNew: card.review_count === 0
  });

  // Penalty when the student got binary-check errors during this card.
  // Applied regardless of final grade: a "good" with multiple Verificar errors
  // is not the same as a clean "good".
  // Pass grade: +0.15 per error, capped at +0.5 (mild but real).
  // Fail grade: flat +0.5 (same as before, stronger signal).
  if (checkFailCount > 0) {
    const difficultyPenalty = isFailGrade(grade)
      ? 0.5
      : Math.min(0.5, checkFailCount * 0.15);
    const minEase = isFailGrade(grade) ? 1.0 : 1.3;
    const penalizedDifficulty = Math.min(10, schedule.difficulty + difficultyPenalty);
    schedule = {
      ...schedule,
      difficulty:  penalizedDifficulty,
      ease_factor: Math.max(minEase, (10 - penalizedDifficulty) / 9 * 1.7 + 1.3)
    };
  }

  const updated = await dbPool.query(
    `UPDATE cards
     SET interval_days = $1, ease_factor = $2, next_review_at = $3,
         stability = $4, difficulty = $5,
         review_count = review_count + 1,
         pass_count   = pass_count + $6,
         avg_response_time_ms = CASE WHEN $7::int IS NOT NULL THEN
           COALESCE(ROUND((COALESCE(avg_response_time_ms, $7::int) + $7::int) / 2.0), $7::int)
           ELSE avg_response_time_ms END,
         avg_review_time_ms = CASE WHEN $8::int IS NOT NULL THEN
           COALESCE(ROUND((COALESCE(avg_review_time_ms, $8::int) + $8::int) / 2.0), $8::int)
           ELSE avg_review_time_ms END,
         last_reviewed_at = now(),
         updated_at = now()
     WHERE id = $9
     RETURNING *`,
    [schedule.interval_days, schedule.ease_factor, schedule.next_review_at,
     schedule.stability, schedule.difficulty,
     isPassGrade(grade) ? 1 : 0, responseTimeMs, reviewTimeMs, cardId]
  );

  // Log activity (logged_date uses Argentina local date)
  dbPool.query(
    `INSERT INTO activity_log (activity_type, subject, grade, response_time_ms, review_time_ms, user_id, logged_date)
     VALUES ('study', $1, $2, $3, $4, $5, (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE)`,
    [updated.rows[0]?.subject || null, grade, responseTimeMs, reviewTimeMs, userId]
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
    // Check subject-level config: enabled flag and per-card cap.
    const configRes = await dbPool.query(
      `SELECT micro_cards_enabled, max_micro_cards_per_card FROM subject_configs WHERE subject = $1 AND user_id = $2`,
      [card.subject || '', userId]
    );
    const microCardsEnabled = configRes.rows[0]?.micro_cards_enabled ?? true;
    if (!microCardsEnabled) {
      return res.status(200).json({ card: updated.rows[0], new_micro_cards: [] });
    }
    const maxPerCard = configRes.rows[0]?.max_micro_cards_per_card ?? null;

    const countRes = await dbPool.query(
      `SELECT COUNT(*) AS cnt FROM micro_cards WHERE parent_card_id = $1 AND user_id = $2 AND status = 'active'`,
      [cardId, userId]
    );
    const existingCount = parseInt(countRes.rows[0].cnt);

    // How many can we still generate this session?
    const slotsAvailable = maxPerCard === null
      ? conceptGaps.length                       // no limit → one per gap (frontend sends top gaps)
      : Math.max(0, maxPerCard - existingCount); // fill up to the cap

    // Rank gaps by acquisition difficulty before slicing, so the most
    // valuable concept always gets the first microcard slot.
    const validGaps = conceptGaps.filter((c) => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim());
    const rankedGaps = await rankGaps({
      prompt_text:          card.prompt_text,
      expected_answer_text: card.expected_answer_text,
      user_answer:          userAnswer,
      gaps:                 validGaps,
    });
    const targetConcepts = rankedGaps.slice(0, slotsAvailable);

    for (const concept of targetConcepts) {
      try {
        const _microFn = isChineseCard(card) ? generateChineseMicroCard : generateMicroCard;
        const micro = await _microFn({
          prompt_text: card.prompt_text,
          expected_answer_text: card.expected_answer_text,
          subject: card.subject,
          concept,
          user_answer: userAnswer
        });

        const inserted = await dbPool.query(
          `INSERT INTO micro_cards (parent_card_id, concept, question, expected_answer, user_id, subject)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [cardId, concept, micro.question, micro.expected_answer, userId, card.subject || null]
        );
        if (inserted.rows.length) newMicroCards.push(inserted.rows[0]);
      } catch (microErr) {
        console.warn(`Failed to generate micro-card for concept "${concept}":`, microErr.message);
      }
    }
  }

  // ── Micro-cards from binary check conceptual errors ───────────────────────
  // Even when the final grade is GOOD/EASY, if the student made conceptual
  // mistakes during "Verificar", generate targeted micro-cards for those errors.
  if (checkFailIds.length > 0) {
    const checkErrorRes = await dbPool.query(
      `SELECT DISTINCT ON (error_label) id, error_label, user_answer
       FROM binary_check_log
       WHERE id = ANY($1) AND error_type = 'conceptual' AND error_label IS NOT NULL
       ORDER BY error_label, id DESC`,
      [checkFailIds]
    );

    if (checkErrorRes.rows.length > 0) {
      // Respect subject-level config (same as conceptGap micro-cards)
      const cfgRes = await dbPool.query(
        `SELECT micro_cards_enabled, max_micro_cards_per_card FROM subject_configs WHERE subject = $1 AND user_id = $2`,
        [card.subject || '', userId]
      );
      const microCardsEnabled = cfgRes.rows[0]?.micro_cards_enabled ?? true;

      if (microCardsEnabled) {
        const maxPerCard = cfgRes.rows[0]?.max_micro_cards_per_card ?? null;
        const countRes   = await dbPool.query(
          `SELECT COUNT(*) AS cnt FROM micro_cards WHERE parent_card_id = $1 AND user_id = $2 AND status = 'active'`,
          [cardId, userId]
        );
        const existingCount  = parseInt(countRes.rows[0].cnt) + newMicroCards.length;
        const slotsAvailable = maxPerCard === null
          ? checkErrorRes.rows.length
          : Math.max(0, maxPerCard - existingCount);

        const targetErrors = checkErrorRes.rows.slice(0, slotsAvailable);

        for (const errRow of targetErrors) {
          try {
            const micro = await generateMicroCardFromCheckError({
              prompt_text:          card.prompt_text,
              expected_answer_text: card.expected_answer_text,
              subject:              card.subject,
              error_label:          errRow.error_label,
              user_answer:          errRow.user_answer || userAnswer,
            });

            const inserted = await dbPool.query(
              `INSERT INTO micro_cards (parent_card_id, concept, question, expected_answer, user_id, subject)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT DO NOTHING
               RETURNING *`,
              [cardId, errRow.error_label, micro.question, micro.expected_answer, userId, card.subject || null]
            );
            if (inserted.rows.length) newMicroCards.push(inserted.rows[0]);
          } catch (microErr) {
            console.error(`[check micro] Failed to generate micro-card for error "${errRow.error_label}":`, microErr.message);
          }
        }
      }
    }
  }

  // Auto-variant generation (fire-and-forget, non-blocking).
  autoGenerateVariant(cardId, card, userId).catch((e) =>
    console.warn('[auto-variant] failed', { cardId, message: e.message })
  );

  return res.status(200).json({
    card: updated.rows[0],
    new_micro_cards: newMicroCards
  });
}

// ─── Internal: review a micro-card ───────────────────────────────────────────
async function reviewMicroCard(res, microCardId, grade, conceptGaps, userAnswer, responseTimeMs, reviewTimeMs, userId) {
  const { rows } = await dbPool.query(
    `SELECT mc.*, c.subject AS parent_subject
     FROM micro_cards mc
     JOIN cards c ON mc.parent_card_id = c.id
     WHERE mc.id = $1 AND mc.user_id = $2`,
    [microCardId, userId]
  );
  if (!rows.length) {
    return res.status(404).json({ error: 'not_found', message: 'Micro-card not found.' });
  }

  const micro = rows[0];
  const effectiveSubject = micro.subject || micro.parent_subject || null;
  const schedule = computeNextReview({
    stability:     parseFloat(micro.stability),
    difficulty:    parseFloat(micro.difficulty),
    lastReviewedAt: micro.last_reviewed_at,
    grade,
    isNew: micro.review_count === 0
  });

  // Archive immediately on any pass-grade (good/easy).
  const newStatus = isPassGrade(grade) ? 'archived' : micro.status;

  const updated = await dbPool.query(
    `UPDATE micro_cards
     SET interval_days = $1, ease_factor = $2, next_review_at = $3,
         stability = $4, difficulty = $5, status = $6,
         review_count = review_count + 1, updated_at = now()
     WHERE id = $7
     RETURNING *`,
    [schedule.interval_days, schedule.ease_factor, schedule.next_review_at,
     schedule.stability, schedule.difficulty, newStatus, microCardId]
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
    `INSERT INTO activity_log (activity_type, subject, grade, response_time_ms, review_time_ms, user_id, logged_date)
     VALUES ('study', $1, $2, $3, $4, $5, (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE)`,
    [effectiveSubject, grade, responseTimeMs, reviewTimeMs, userId]
  ).catch((e) => console.warn('[activity log]', e.message));

  // ── Sibling micro-card generation ─────────────────────────────────────────
  // When the subject has micro_cards_spawn_siblings enabled and the student
  // failed (non-pass grade), generate new sibling micros for the concept gaps,
  // using the parent card as knowledge context.
  let newMicroCards = [];

  const gaps = Array.isArray(conceptGaps) ? conceptGaps : [];
  if (!isPassGrade(grade) && gaps.length > 0) {
    const configRes = await dbPool.query(
      `SELECT micro_cards_spawn_siblings, micro_cards_enabled, max_micro_cards_per_card
       FROM subject_configs WHERE subject = $1 AND user_id = $2`,
      [effectiveSubject || '', userId]
    );
    const spawnSiblings  = configRes.rows[0]?.micro_cards_spawn_siblings ?? false;
    const microEnabled   = configRes.rows[0]?.micro_cards_enabled ?? true;

    if (spawnSiblings && microEnabled) {
      // Fetch parent card for generation context.
      const { rows: parentRows } = await dbPool.query(
        'SELECT prompt_text, expected_answer_text, subject FROM cards WHERE id = $1',
        [micro.parent_card_id]
      );
      const parent = parentRows[0];

      if (parent) {
        const maxPerCard    = configRes.rows[0]?.max_micro_cards_per_card ?? null;
        const { rows: cnt } = await dbPool.query(
          `SELECT COUNT(*) AS n FROM micro_cards WHERE parent_card_id = $1 AND user_id = $2 AND status = 'active'`,
          [micro.parent_card_id, userId]
        );
        const existingCount  = parseInt(cnt[0].n);
        const slotsAvailable = maxPerCard === null
          ? gaps.length
          : Math.max(0, maxPerCard - existingCount);

        const validSiblingGaps = gaps.filter((c) => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim());
        const rankedSiblingGaps = await rankGaps({
          prompt_text:          parent.prompt_text,
          expected_answer_text: parent.expected_answer_text,
          user_answer:          userAnswer || '',
          gaps:                 validSiblingGaps,
        });
        const targetConcepts = rankedSiblingGaps.slice(0, slotsAvailable);

        for (const concept of targetConcepts) {
          try {
            const _siblingFn = isChineseCard(parent) ? generateChineseMicroCard : generateMicroCard;
            const sibling = await _siblingFn({
              prompt_text:          parent.prompt_text,
              expected_answer_text: parent.expected_answer_text,
              subject:              micro.subject || parent.subject,
              concept,
              user_answer:          userAnswer || ''
            });
            const inserted = await dbPool.query(
              `INSERT INTO micro_cards (parent_card_id, concept, question, expected_answer, user_id, subject)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT DO NOTHING
               RETURNING *`,
              [micro.parent_card_id, concept, sibling.question, sibling.expected_answer, userId, micro.subject || parent.subject || null]
            );
            if (inserted.rows.length) newMicroCards.push(inserted.rows[0]);
          } catch (err) {
            console.warn(`Failed to generate sibling micro-card for concept "${concept}":`, err.message);
          }
        }
      }
    }
  }

  return res.status(200).json({
    micro_card: updated.rows[0],
    parent_unblocked: parentUnblocked,
    new_micro_cards: newMicroCards
  });
}

// ─── Exam simulation: pick weakest cards for a subject ───────────────────────
schedulerRouter.post('/scheduler/exam-sim', async (req, res) => {
  const userId = req.user.id;
  const { subject, count = 10, examFocusPrompt } = req.body || {};

  if (!subject || typeof subject !== 'string' || !subject.trim()) {
    return res.status(422).json({ error: 'validation_error', message: 'subject is required.' });
  }

  const parsedCount = Math.min(50, Math.max(1, parseInt(count, 10) || 10));

  try {
    const [cardsResult, simHistoryResult] = await Promise.all([
      dbPool.query(
        `SELECT c.id, c.prompt_text, c.expected_answer_text, c.subject,
                c.interval_days, c.ease_factor, c.pass_count, c.review_count,
                COUNT(mc.id) FILTER (WHERE mc.status = 'active') AS active_micro_count
         FROM cards c
         LEFT JOIN micro_cards mc ON mc.parent_card_id = c.id AND mc.user_id = c.user_id
         WHERE c.user_id = $1
           AND c.subject = $2
           AND c.archived_at IS NULL
           AND c.suspended_at IS NULL
         GROUP BY c.id`,
        [userId, subject.trim()]
      ),
      // Fetch recent sim logs (last 60 days) to recalibrate scores
      dbPool.query(
        `SELECT results, created_at FROM exam_sim_logs
         WHERE user_id = $1 AND subject = $2
           AND created_at >= now() - interval '60 days'
         ORDER BY created_at DESC
         LIMIT 20`,
        [userId, subject.trim()]
      )
    ]);

    const rows = cardsResult.rows;
    if (!rows.length) {
      return res.json({ cards: [], subject: subject.trim(), total_available: 0 });
    }

    // Build a map: card_id → [{grade, daysAgo}, ...] sorted most-recent-first.
    // We iterate logs already sorted DESC so each push preserves that order.
    const simHistoryByCard = {};
    const now = Date.now();
    for (const log of simHistoryResult.rows) {
      const daysAgo = (now - new Date(log.created_at).getTime()) / 86400000;
      for (const item of (log.results || [])) {
        if (!item.card_id) continue;
        const id = String(item.card_id);
        if (!simHistoryByCard[id]) simHistoryByCard[id] = [];
        simHistoryByCard[id].push({ grade: item.grade, daysAgo });
      }
    }

    // Weakness score: combines pass rate, SM-2 ease factor, retention interval,
    // active micro-gaps, and cumulative exam simulation performance.
    const scored = rows.map((card) => {
      const passCount    = parseInt(card.pass_count)   || 0;
      const reviewCount  = parseInt(card.review_count) || 0;
      const passRate     = reviewCount >= 2 ? passCount / reviewCount : 0.5;
      const easeFactor   = Math.max(1.3, parseFloat(card.ease_factor) || 2.5);
      const intervalDays = Math.max(1,   parseFloat(card.interval_days) || 1);
      const hasMicros    = parseInt(card.active_micro_count) > 0 ? 1 : 0;

      const base = (1 - passRate)                         * 0.40
                 + Math.max(0, (2.5 - easeFactor) / 1.2) * 0.30
                 + 1 / (intervalDays + 1)                 * 0.20
                 + hasMicros                               * 0.10;

      // Recalibrate based on cumulative sim performance.
      // Count consecutive passes from most-recent backwards; a fail breaks the streak.
      // More consecutive passes → stronger and longer-lasting reduction.
      // A fail resets the streak and boosts the score (confirmed weak area).
      let simModifier = 1.0;
      const simHistory = simHistoryByCard[String(card.id)];
      if (simHistory && simHistory.length > 0) {
        const mostRecent = simHistory[0];
        // Decay window scales with streak: 1 pass = 14d, 2 = 21d, 3+ = 30d
        let passStreak = 0;
        for (const entry of simHistory) {
          if (entry.grade === 'easy' || entry.grade === 'good') passStreak++;
          else break;
        }
        const decayDays = passStreak >= 3 ? 30 : passStreak === 2 ? 21 : 14;
        const recency = Math.max(0, 1 - mostRecent.daysAgo / decayDays);

        if (passStreak >= 3)     simModifier = 1 - 0.70 * recency; // strong mastery
        else if (passStreak === 2) simModifier = 1 - 0.60 * recency;
        else if (passStreak === 1) simModifier = 1 - 0.45 * recency;
        else {
          // Most recent was a fail — boost
          const boost = mostRecent.grade === 'again' ? 0.35 : 0.20;
          simModifier = 1 + boost * recency;
        }
      }

      const score = Math.max(0, base * simModifier);
      return {
        ...card,
        weakness_score:  Math.round(score * 1000) / 1000,
        sim_recalibrated: simHistory ? simHistory.length > 0 : false
      };
    });

    // If the user provided an exam focus prompt, apply LLM-based relevance multipliers.
    // Cards matching the exam topics get boosted; off-topic cards get heavily suppressed.
    const focusText = typeof examFocusPrompt === 'string' ? examFocusPrompt.trim() : '';
    if (focusText) {
      const relevanceMap = await scoreCardsByExamFocus(scored, focusText);
      for (const card of scored) {
        const multiplier = relevanceMap[String(card.id)] ?? 1.0;
        card.weakness_score = Math.round(card.weakness_score * multiplier * 1000) / 1000;
        card.exam_focus_relevance = multiplier >= 2.0 ? 'high' : multiplier >= 1.0 ? 'medium' : 'low';
      }
    }

    scored.sort((a, b) => b.weakness_score - a.weakness_score);
    const selected = scored.slice(0, parsedCount);

    return res.json({
      cards: selected,
      subject: subject.trim(),
      total_available: rows.length,
      exam_focus_active: !!focusText,
    });
  } catch (err) {
    console.error('POST /scheduler/exam-sim error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ─── Exam simulation: save log ────────────────────────────────────────────────
schedulerRouter.post('/scheduler/exam-sim/log', async (req, res) => {
  const userId = req.user.id;
  const { subject, correct, total, score_pct, results = [] } = req.body || {};

  if (!subject || typeof subject !== 'string') {
    return res.status(422).json({ error: 'validation_error', message: 'subject is required.' });
  }
  if (!Number.isFinite(Number(correct)) || !Number.isFinite(Number(total)) || Number(total) < 1) {
    return res.status(422).json({ error: 'validation_error', message: 'correct and total are required.' });
  }

  try {
    const { rows } = await dbPool.query(
      `INSERT INTO exam_sim_logs (user_id, subject, correct, total, score_pct, results)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [userId, subject.trim(), Number(correct), Number(total),
       Number(score_pct) || Math.round((Number(correct) / Number(total)) * 100),
       JSON.stringify(results)]
    );
    return res.json({ id: rows[0].id, created_at: rows[0].created_at });
  } catch (err) {
    console.error('POST /scheduler/exam-sim/log error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

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
      `INSERT INTO card_variants (card_id, prompt_text, expected_answer_text, user_id, variant_type)
       VALUES ($1, $2, $3, $4, 'regular') RETURNING *`,
      [cardId, variant.prompt_text, variant.expected_answer_text, userId]
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

// GET /scheduler/cards/:id/variants
// Returns the parent card + all its variants for tree visualisation.
schedulerRouter.get('/scheduler/cards/:id/variants', async (req, res) => {
  const cardId = parseInt(req.params.id);
  const userId = req.user.id;
  if (!cardId) return res.status(422).json({ error: 'validation_error', message: 'Invalid card id.' });

  try {
    const cardRes = await dbPool.query(
      `SELECT id, subject, prompt_text, expected_answer_text, created_at
       FROM cards
       WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
      [cardId, userId]
    );
    if (!cardRes.rows.length) return res.status(404).json({ error: 'not_found', message: 'Card not found.' });

    const variantsRes = await dbPool.query(
      `SELECT id, prompt_text, expected_answer_text, created_at
       FROM card_variants
       WHERE card_id = $1 AND (user_id = $2 OR user_id IS NULL)
       ORDER BY created_at ASC`,
      [cardId, userId]
    );

    return res.json({ card: cardRes.rows[0], variants: variantsRes.rows });
  } catch (err) {
    console.error('GET /scheduler/cards/:id/variants', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /scheduler/daily-summary
// Returns today's review count, minutes studied, and per-subject priority allocation.
schedulerRouter.get('/scheduler/daily-summary', async (req, res) => {
  const userId = req.user.id;
  const budgetMinutes = Math.max(10, parseInt(req.query.budget_minutes) || 120);

  try {
    const [reviewsRes, minutesRes, subjectRes] = await Promise.all([
      dbPool.query(
        `SELECT COUNT(*) AS cnt
         FROM activity_log
         WHERE user_id = $1
           AND activity_type = 'study'
           AND logged_date = (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE`,
        [userId]
      ),
      dbPool.query(
        `SELECT COALESCE(SUM(actual_minutes), 0) AS total_minutes
         FROM study_sessions
         WHERE user_id = $1
           AND (started_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE
               = (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE`,
        [userId]
      ),
      dbPool.query(
        `SELECT
           COALESCE(c.subject, '(sin materia)') AS subject,
           COUNT(DISTINCT c.id)                  AS cards_due,
           COUNT(DISTINCT mc.id)                 AS micros_due,
           MIN(se.exam_date)                     AS exam_date,
           (SELECT se2.label
            FROM subject_exam_dates se2
            WHERE se2.subject = c.subject
              AND se2.user_id = $1
              AND se2.exam_date = MIN(se.exam_date)
            LIMIT 1) AS exam_label
         FROM cards c
         LEFT JOIN micro_cards mc
           ON mc.parent_card_id = c.id
          AND mc.status = 'active'
          AND mc.next_review_at <= now()
         LEFT JOIN subject_exam_dates se
           ON se.subject = c.subject
          AND se.user_id = $1
          AND se.exam_date >= CURRENT_DATE
         WHERE c.user_id = $1
           AND c.archived_at IS NULL
           AND c.suspended_at IS NULL
           AND c.next_review_at <= now()
         GROUP BY c.subject
         ORDER BY exam_date ASC NULLS LAST`,
        [userId]
      )
    ]);

    const reviewsDoneToday = parseInt(reviewsRes.rows[0]?.cnt || 0);
    const minutesStudiedToday = parseFloat(minutesRes.rows[0]?.total_minutes || 0);

    const rows = subjectRes.rows.map((row) => {
      const cardsDue = parseInt(row.cards_due || 0);
      const microsDue = parseInt(row.micros_due || 0);
      const examDate = row.exam_date ? new Date(row.exam_date) : null;

      let daysUntilExam = null;
      let urgencyScore = 0.5;
      let urgencyLabel = 'low';

      if (examDate) {
        const now = new Date();
        daysUntilExam = Math.ceil((examDate - now) / 86400000);
        if (daysUntilExam <= 1)       { urgencyScore = 10;  urgencyLabel = 'critical'; }
        else if (daysUntilExam <= 3)  { urgencyScore = 4.0; urgencyLabel = 'critical'; }
        else if (daysUntilExam <= 7)  { urgencyScore = 2.5; urgencyLabel = 'high'; }
        else if (daysUntilExam <= 14) { urgencyScore = 1.5; urgencyLabel = 'medium'; }
        else if (daysUntilExam <= 30) { urgencyScore = 1.0; urgencyLabel = 'medium'; }
        else                           { urgencyScore = 0.5; urgencyLabel = 'low'; }
      }

      const backlog = Math.min(1.0, (cardsDue + microsDue) / 20);
      const weight = urgencyScore * 0.7 + backlog * 0.3;

      return { subject: row.subject, cards_due: cardsDue, micros_due: microsDue,
               days_until_exam: daysUntilExam, exam_label: row.exam_label || null,
               urgency: urgencyLabel, _weight: weight };
    });

    const totalWeight = rows.reduce((s, r) => s + r._weight, 0);

    const subjectPriority = rows.map(({ _weight, ...r }) => ({
      ...r,
      suggested_minutes: totalWeight > 0 ? Math.round((_weight / totalWeight) * budgetMinutes) : 0
    }));

    return res.json({
      reviews_done_today: reviewsDoneToday,
      minutes_studied_today: minutesStudiedToday,
      subject_priority: subjectPriority
    });
  } catch (err) {
    console.error('GET /scheduler/daily-summary', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default schedulerRouter;
