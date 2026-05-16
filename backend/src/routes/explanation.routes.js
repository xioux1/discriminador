import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { requireAuth } from '../middleware/auth.js';
import { llmRateLimit } from '../middleware/llm-rate-limit.js';
import { generateExplanationArtifact } from '../services/explanationArtifact.service.js';

const explanationRouter = Router();

explanationRouter.use(requireAuth);

function rowToArtifact(row) {
  return {
    id: row.id,
    card_id: row.card_id,
    variant_id: row.variant_id ?? null,
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
  };
}

// GET /api/cards/:id/explanation-artifact?variant_id=N
explanationRouter.get('/api/cards/:id/explanation-artifact', async (req, res) => {
  try {
    const userId    = req.user.id;
    const cardId    = req.params.id;
    const variantId = req.query.variant_id ? Number(req.query.variant_id) : null;

    const { rows } = variantId
      ? await dbPool.query(
          `SELECT * FROM card_explanation_artifacts
             WHERE card_id = $1 AND user_id = $2 AND variant_id = $3`,
          [cardId, userId, variantId],
        )
      : await dbPool.query(
          `SELECT * FROM card_explanation_artifacts
             WHERE card_id = $1 AND user_id = $2 AND variant_id IS NULL`,
          [cardId, userId],
        );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'No explanation artifact for this card.' });
    }
    return res.json(rowToArtifact(rows[0]));
  } catch (err) {
    console.error('[explanation] GET error:', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /api/cards/:id/explanation-artifact/generate
// Body: { variant_id?: number, force?: boolean }
explanationRouter.post('/api/cards/:id/explanation-artifact/generate', llmRateLimit, async (req, res) => {
  try {
    const userId    = req.user.id;
    const cardId    = req.params.id;
    const variantId = req.body?.variant_id ? Number(req.body.variant_id) : null;
    const force     = req.body?.force === true;

    // Verify base card belongs to this user.
    const cardRes = await dbPool.query(
      `SELECT id, prompt_text, expected_answer_text, subject, card_type FROM cards WHERE id = $1 AND user_id = $2`,
      [cardId, userId],
    );
    if (cardRes.rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Card not found.' });
    }
    const baseCard = cardRes.rows[0];

    // If a variant, fetch variant's own prompt + answer.
    let promptText        = baseCard.prompt_text;
    let expectedAnswerText = baseCard.expected_answer_text;
    if (variantId) {
      const varRes = await dbPool.query(
        `SELECT prompt_text, expected_answer_text FROM card_variants WHERE id = $1 AND card_id = $2`,
        [variantId, cardId],
      );
      if (varRes.rows.length === 0) {
        return res.status(404).json({ error: 'not_found', message: 'Variant not found.' });
      }
      promptText         = varRes.rows[0].prompt_text;
      expectedAnswerText = varRes.rows[0].expected_answer_text;
    }

    // Return cached unless forced.
    if (!force) {
      const existing = variantId
        ? await dbPool.query(
            `SELECT * FROM card_explanation_artifacts WHERE card_id = $1 AND user_id = $2 AND variant_id = $3`,
            [cardId, userId, variantId],
          )
        : await dbPool.query(
            `SELECT * FROM card_explanation_artifacts WHERE card_id = $1 AND user_id = $2 AND variant_id IS NULL`,
            [cardId, userId],
          );
      if (existing.rows.length > 0) {
        return res.json({ ...rowToArtifact(existing.rows[0]), cached: true });
      }
    }

    let artifact;
    try {
      artifact = await generateExplanationArtifact({
        cardId,
        cardFront: promptText,
        cardBack:  expectedAnswerText,
        cardType:  baseCard.card_type,
        subject:   baseCard.subject,
        language:  'es',
      });
    } catch (err) {
      console.error('[explanation] generation error:', err.message);
      return res.status(500).json({ error: 'generation_failed', message: err.message });
    }

    const { diagram = {}, reveal_steps, quality_flags, oral_explanation_short, oral_explanation_detailed, expected_answer } = artifact;
    const { type: diagram_type, title, nodes, edges, columns, steps } = diagram;
    const diagram_spec = { title, nodes, edges, columns, steps };
    const modelName = process.env.LLM_MICRO_MODEL || 'claude-haiku-4-5-20251001';

    const insertVals = [
      cardId, userId, variantId, 'es',
      expected_answer, oral_explanation_short, oral_explanation_detailed,
      diagram_type, JSON.stringify(diagram_spec),
      JSON.stringify(reveal_steps || []), JSON.stringify(quality_flags || {}),
      modelName,
    ];
    const updateSet = `language=EXCLUDED.language, expected_answer=EXCLUDED.expected_answer,
      oral_explanation_short=EXCLUDED.oral_explanation_short,
      oral_explanation_detailed=EXCLUDED.oral_explanation_detailed,
      diagram_type=EXCLUDED.diagram_type, diagram_spec=EXCLUDED.diagram_spec,
      reveal_steps=EXCLUDED.reveal_steps, quality_flags=EXCLUDED.quality_flags,
      model_name=EXCLUDED.model_name, updated_at=now()`;
    const insertCols = `(card_id,user_id,variant_id,language,expected_answer,
      oral_explanation_short,oral_explanation_detailed,diagram_type,diagram_spec,
      reveal_steps,quality_flags,model_name,generated_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now(),now())`;

    if (variantId) {
      await dbPool.query(
        `INSERT INTO card_explanation_artifacts ${insertCols}
         ON CONFLICT (card_id,user_id,variant_id) WHERE variant_id IS NOT NULL
         DO UPDATE SET ${updateSet}`,
        insertVals,
      );
    } else {
      await dbPool.query(
        `INSERT INTO card_explanation_artifacts ${insertCols}
         ON CONFLICT (card_id,user_id) WHERE variant_id IS NULL
         DO UPDATE SET ${updateSet}`,
        insertVals,
      );
    }

    return res.json({ ...artifact, diagram: { type: diagram_type, ...diagram_spec }, cached: false });
  } catch (err) {
    console.error('[explanation] POST error:', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default explanationRouter;
