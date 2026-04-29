import Anthropic from '@anthropic-ai/sdk';
import { Router } from 'express';
import {
  generateCardDraftForCluster,
  buildClusterCardContext,
  buildCardGenerationPrompt,
  getDefaultMaxVariantsForCluster,
  validateGeneratedCardDraft,
  safeJsonParseObject,
} from '../services/cardGeneration.service.js';
import { generateChineseCardDraftForCluster } from '../services/chineseCardGeneration.service.js';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

async function getClusterSubject(clusterId) {
  const { rows } = await dbPool.query(
    `SELECT d.subject FROM clusters cl JOIN documents d ON d.id = cl.document_id WHERE cl.id = $1`,
    [clusterId]
  );
  return rows[0]?.subject || null;
}

function isChineseSubject(subject) {
  const s = (subject || '').toLowerCase().trim();
  return s === 'chino' || s === 'chinese' || s === 'mandarín' || s === 'mandarin' || s.includes('chino');
}

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/clusters/:id/generate-card-draft
router.post('/api/clusters/:id/generate-card-draft', async (req, res, next) => {
  const clusterId = req.params.id;

  if (!UUID_RE.test(clusterId)) {
    return res.status(400).json({
      error: 'invalid_id',
      message: 'Cluster ID must be a valid UUID.',
    });
  }

  const { max_variants, language = 'es', card_type } = req.body ?? {};

  // Detect Chinese clusters and route to the specialized generator
  const subject = await getClusterSubject(clusterId);
  if (isChineseSubject(subject) || card_type === 'chinese_sentence') {
    try {
      const result = await generateChineseCardDraftForCluster(clusterId, {
        max_variants,
        userId: req.user?.id ?? null,
      });
      return res.status(201).json(result);
    } catch (err) {
      if (err.statusCode === 409) return res.status(409).json({ error: 'draft_exists', message: err.message, existing_card_id: err.existingCardId });
      if (err.statusCode === 404) return res.status(404).json({ error: 'not_found', message: err.message });
      if (err.statusCode === 400) return res.status(400).json({ error: 'validation_error', message: err.message });
      if (err.statusCode === 422) return res.status(422).json({ error: 'generation_failed', message: err.message });
      logger.error('[generateCardDraft] Chinese unexpected error', { clusterId, error: err.message });
      return next(err);
    }
  }

  const resolvedCardType = card_type ?? 'theoretical_open';
  if (resolvedCardType !== 'theoretical_open') {
    return res.status(400).json({
      error: 'invalid_card_type',
      message: 'Only card_type "theoretical_open" is supported for non-Chinese documents.',
    });
  }

  if (language !== 'es') {
    return res.status(400).json({
      error: 'invalid_language',
      message: 'Only language "es" is supported in this version.',
    });
  }

  try {
    const result = await generateCardDraftForCluster(clusterId, {
      max_variants,
      userId: req.user?.id ?? null,
    });
    return res.status(201).json(result);
  } catch (err) {
    if (err.statusCode === 409) {
      return res.status(409).json({
        error: 'draft_exists',
        message: err.message,
        existing_card_id: err.existingCardId,
      });
    }
    if (err.statusCode === 404) {
      return res.status(404).json({ error: 'not_found', message: err.message });
    }
    if (err.statusCode === 400) {
      return res.status(400).json({ error: 'validation_error', message: err.message });
    }
    if (err.statusCode === 422) {
      return res.status(422).json({ error: 'generation_failed', message: err.message });
    }
    if (err.statusCode === 502) {
      return res.status(502).json({ error: 'upstream_error', message: err.message });
    }
    logger.error('[generateCardDraft] Unexpected error', { clusterId, error: err.message });
    return next(err);
  }
});

// POST /api/clusters/:id/preview-card-draft
// Runs the full pipeline but does NOT persist. Returns generated JSON for review.
router.post('/api/clusters/:id/preview-card-draft', async (req, res, next) => {
  const clusterId = req.params.id;

  if (!UUID_RE.test(clusterId)) {
    return res.status(400).json({
      error: 'invalid_id',
      message: 'Cluster ID must be a valid UUID.',
    });
  }

  const { max_variants } = req.body ?? {};

  try {
    const context = await buildClusterCardContext(clusterId);

    let maxVariants = getDefaultMaxVariantsForCluster(context.cluster);
    if (max_variants != null) {
      const requested = Number(max_variants);
      if (Number.isFinite(requested) && requested >= 1) {
        maxVariants = Math.min(requested, 8);
      }
    }
    maxVariants = Math.min(maxVariants, context.concepts.length);
    if (maxVariants < 1) maxVariants = 1;

    const prompt = buildCardGenerationPrompt(context, { maxVariants });

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const model =
      process.env.CARD_GENERATION_MODEL ||
      process.env.CONCEPT_EXTRACTION_MODEL ||
      'claude-sonnet-4-20250514';
    const maxTokens = maxVariants <= 3 ? 2500 : maxVariants <= 5 ? 4000 : 5000;

    const message = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      temperature: 0.1,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawContent = message.content?.[0]?.text ?? '';
    const parsed = safeJsonParseObject(rawContent);

    if (!parsed) {
      return res.status(502).json({ error: 'upstream_error', message: 'LLM returned invalid JSON.' });
    }

    const validation = validateGeneratedCardDraft(parsed, context, maxVariants);

    return res.json({
      status: 'preview',
      cluster_id: clusterId,
      valid: validation.valid,
      errors: validation.errors,
      card_group: parsed.card_group,
      variants: validation.validVariants,
      raw_variants_count: parsed.variants?.length ?? 0,
    });
  } catch (err) {
    if (err.statusCode === 404) {
      return res.status(404).json({ error: 'not_found', message: err.message });
    }
    if (err.statusCode === 400) {
      return res.status(400).json({ error: 'validation_error', message: err.message });
    }
    logger.error('[previewCardDraft] Unexpected error', { clusterId, error: err.message });
    return next(err);
  }
});

// GET /api/clusters/:id/card-draft
// Returns the existing draft card + variants for a cluster, or 404.
router.get('/api/clusters/:id/card-draft', async (req, res, next) => {
  const clusterId = req.params.id;

  if (!UUID_RE.test(clusterId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Cluster ID must be a valid UUID.' });
  }

  try {
    const { rows: cardRows } = await dbPool.query(
      `SELECT id, prompt_text AS title, prompt_text, expected_answer_text, card_type, status, subject
       FROM cards WHERE cluster_id = $1 AND status = 'draft' LIMIT 1`,
      [clusterId]
    );

    if (!cardRows.length) {
      return res.status(404).json({ error: 'not_found', message: 'No card draft found for this cluster.' });
    }

    const card = cardRows[0];

    // Primary variant lives on the parent card itself; extra variants in card_variants
    const { rows: extraVariants } = await dbPool.query(
      `SELECT id,
              prompt_text          AS question,
              expected_answer_text AS expected_answer,
              grading_rubric, difficulty, answer_time_seconds,
              source_concept_ids, source_chunk_indexes
       FROM card_variants
       WHERE card_id = $1 AND status = 'draft'
       ORDER BY id`,
      [card.id]
    );

    const primaryVariant = {
      id: null,
      question: card.prompt_text,
      expected_answer: card.expected_answer_text,
      grading_rubric: [],
      difficulty: 'medium',
      answer_time_seconds: 50,
      source_concept_ids: [],
      source_chunk_indexes: [],
    };

    return res.json({
      status: 'draft_found',
      cluster_id: clusterId,
      card_group: { id: card.id, title: card.title, card_type: card.card_type, status: card.status, subject: card.subject },
      variants: [primaryVariant, ...extraVariants],
    });
  } catch (err) {
    logger.error('[getCardDraft] Error', { clusterId, error: err.message });
    return next(err);
  }
});

// GET /api/cards/subjects — distinct subjects known to this user (for autocomplete)
router.get('/api/cards/subjects', async (req, res, next) => {
  const userId = req.user?.id;
  try {
    const { rows } = await dbPool.query(
      `SELECT subject FROM (
         SELECT DISTINCT subject FROM cards
           WHERE user_id = $1 AND subject IS NOT NULL AND subject <> ''
         UNION
         SELECT DISTINCT subject FROM subject_configs
           WHERE user_id = $1 AND subject IS NOT NULL AND subject <> ''
       ) AS combined
       ORDER BY subject`,
      [userId]
    );
    return res.json({ subjects: rows.map(r => r.subject) });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/cards/:id/accept-draft — activate draft card + variants, set subject
router.patch('/api/cards/:id/accept-draft', async (req, res, next) => {
  const cardId = parseInt(req.params.id, 10);
  if (!Number.isFinite(cardId) || cardId <= 0) {
    return res.status(400).json({ error: 'invalid_id', message: 'Card ID must be a positive integer.' });
  }

  const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : null;

  try {
    const { rows: cardRows } = await dbPool.query(
      `SELECT id FROM cards WHERE id = $1 AND status = 'draft'`,
      [cardId]
    );
    if (!cardRows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Draft card not found.' });
    }

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');

      const { rows: updated } = await client.query(
        `UPDATE cards
         SET status = 'active',
             subject = CASE WHEN $1::text IS NOT NULL AND $1::text <> '' THEN $1::text ELSE subject END,
             updated_at = NOW()
         WHERE id = $2
         RETURNING id, status, subject, cluster_id`,
        [subject || null, cardId]
      );

      const { rows: activatedVariants } = await client.query(
        `UPDATE card_variants SET status = 'active' WHERE card_id = $1 AND status = 'draft' RETURNING id`,
        [cardId]
      );

      // Record the acceptance on the cluster (1 primary card + N variants)
      const cardsAddedCount = 1 + activatedVariants.length;
      const clusterId = updated[0]?.cluster_id;
      if (clusterId) {
        await client.query(
          `UPDATE clusters
           SET cards_added_at      = NOW(),
               cards_added_count   = $1,
               cards_added_subject = $2
           WHERE id = $3`,
          [cardsAddedCount, subject || null, clusterId]
        );
      }

      await client.query('COMMIT');

      return res.json({
        status: 'accepted',
        card: updated[0],
        cards_added_count: cardsAddedCount,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('[acceptDraft] Error', { cardId, error: err.message });
    return next(err);
  }
});

export default router;
