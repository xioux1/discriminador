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
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

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

  const { max_variants, language = 'es', card_type = 'theoretical_open' } = req.body ?? {};

  if (card_type !== 'theoretical_open') {
    return res.status(400).json({
      error: 'invalid_card_type',
      message: 'Only card_type "theoretical_open" is supported in this version.',
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
      `SELECT id, prompt_text AS title, card_type, status
       FROM cards WHERE cluster_id = $1 AND status = 'draft' LIMIT 1`,
      [clusterId]
    );

    if (!cardRows.length) {
      return res.status(404).json({ error: 'not_found', message: 'No card draft found for this cluster.' });
    }

    const card = cardRows[0];

    const { rows: variants } = await dbPool.query(
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

    return res.json({
      status: 'draft_found',
      cluster_id: clusterId,
      card_group: { id: card.id, title: card.title, card_type: card.card_type, status: card.status },
      variants,
    });
  } catch (err) {
    logger.error('[getCardDraft] Error', { clusterId, error: err.message });
    return next(err);
  }
});

export default router;

