import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { llmRateLimit } from '../middleware/llm-rate-limit.js';
import { generateExplanationArtifact } from '../services/explanationArtifact.service.js';

const explanationRouter = Router();

explanationRouter.use(requireAuth);

// GET /api/cards/:id/explanation-artifact
// Returns the cached explanation artifact for a card, or 404 if not yet generated.
explanationRouter.get('/api/cards/:id/explanation-artifact', async (req, res) => {
  const userId = req.user.id;
  const cardId = req.params.id;

  const { rows } = await dbPool.query(
    `SELECT * FROM card_explanation_artifacts WHERE card_id = $1 AND user_id = $2`,
    [cardId, userId],
  );

  if (rows.length === 0) {
    return res.status(404).json({ error: 'not_found', message: 'No explanation artifact for this card.' });
  }

  const row = rows[0];
  return res.json({
    id: row.id,
    card_id: row.card_id,
    version: row.version,
    language: row.language,
    expected_answer: row.expected_answer,
    oral_explanation_short: row.oral_explanation_short,
    oral_explanation_detailed: row.oral_explanation_detailed,
    diagram: { type: row.diagram_type, ...(row.diagram_spec || {}) },
    reveal_steps: row.reveal_steps || [],
    quality_flags: row.quality_flags || {},
    model_name: row.model_name,
    generated_at: row.generated_at,
  });
});

// POST /api/cards/:id/explanation-artifact/generate
// Generates (or regenerates) the explanation artifact for a card.
explanationRouter.post('/api/cards/:id/explanation-artifact/generate', llmRateLimit, async (req, res) => {
  const userId = req.user.id;
  const cardId = req.params.id;
  const force  = req.body?.force === true;

  // Verify the card belongs to this user
  const cardRes = await dbPool.query(
    `SELECT id, prompt_text, expected_answer_text, subject, card_type, tags
       FROM cards WHERE id = $1 AND user_id = $2`,
    [cardId, userId],
  );
  if (cardRes.rows.length === 0) {
    return res.status(404).json({ error: 'not_found', message: 'Card not found.' });
  }
  const card = cardRes.rows[0];

  // Return existing unless forced
  if (!force) {
    const existing = await dbPool.query(
      `SELECT * FROM card_explanation_artifacts WHERE card_id = $1 AND user_id = $2`,
      [cardId, userId],
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      return res.json({
        id: row.id,
        card_id: row.card_id,
        version: row.version,
        language: row.language,
        expected_answer: row.expected_answer,
        oral_explanation_short: row.oral_explanation_short,
        oral_explanation_detailed: row.oral_explanation_detailed,
        diagram: { type: row.diagram_type, ...(row.diagram_spec || {}) },
        reveal_steps: row.reveal_steps || [],
        quality_flags: row.quality_flags || {},
        model_name: row.model_name,
        generated_at: row.generated_at,
        cached: true,
      });
    }
  }

  let artifact;
  try {
    artifact = await generateExplanationArtifact({
      cardId,
      cardFront: card.prompt_text,
      cardBack:  card.expected_answer_text,
      cardType:  card.card_type,
      subject:   card.subject,
      language:  'es',
      labels:    card.tags || [],
    });
  } catch (err) {
    console.error('[explanation] generation error:', err.message);
    return res.status(500).json({ error: 'generation_failed', message: err.message });
  }

  const { diagram = {}, reveal_steps, quality_flags, oral_explanation_short, oral_explanation_detailed, expected_answer } = artifact;
  const { type: diagram_type, title, nodes, edges, columns, steps } = diagram;
  const diagram_spec = { title, nodes, edges, columns, steps };

  const modelName = process.env.LLM_MICRO_MODEL || 'claude-haiku-4-5-20251001';

  await dbPool.query(
    `INSERT INTO card_explanation_artifacts
       (card_id, user_id, language, expected_answer, oral_explanation_short, oral_explanation_detailed,
        diagram_type, diagram_spec, reveal_steps, quality_flags, model_name, generated_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())
     ON CONFLICT (card_id, user_id) DO UPDATE SET
       language                  = EXCLUDED.language,
       expected_answer           = EXCLUDED.expected_answer,
       oral_explanation_short    = EXCLUDED.oral_explanation_short,
       oral_explanation_detailed = EXCLUDED.oral_explanation_detailed,
       diagram_type              = EXCLUDED.diagram_type,
       diagram_spec              = EXCLUDED.diagram_spec,
       reveal_steps              = EXCLUDED.reveal_steps,
       quality_flags             = EXCLUDED.quality_flags,
       model_name                = EXCLUDED.model_name,
       updated_at                = now()`,
    [
      cardId, userId, 'es',
      expected_answer,
      oral_explanation_short,
      oral_explanation_detailed,
      diagram_type,
      JSON.stringify(diagram_spec),
      JSON.stringify(reveal_steps || []),
      JSON.stringify(quality_flags || {}),
      modelName,
    ],
  );

  return res.json({
    ...artifact,
    diagram: { type: diagram_type, ...diagram_spec },
    cached: false,
  });
});

export default explanationRouter;
