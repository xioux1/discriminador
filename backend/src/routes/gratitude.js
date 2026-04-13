import { Router } from 'express';
import { dbPool } from '../db/client.js';
import Anthropic from '@anthropic-ai/sdk';

const gratitudeRouter = Router();

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

// POST /gratitude — log gratitude entry and get a Haiku response
gratitudeRouter.post('/gratitude', async (req, res) => {
  const userId = req.user.id;
  const { text } = req.body || {};

  if (!text || typeof text !== 'string' || text.trim().length < 3) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'Escribí algo por lo que estés agradecido (mínimo 3 caracteres).',
    });
  }

  const trimmed = text.trim();

  // Call Haiku for a warm motivational response (non-fatal if it fails)
  let llmResponse = null;
  try {
    const msg = await getClient().messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content:
            `El usuario está por empezar una sesión de estudio y escribió esto como algo por lo que está agradecido:\n\n"${trimmed}"\n\nResponde con un mensaje breve, cálido y motivador en español (2-3 oraciones). Reconocé lo que escribió y animalo a estudiar con esa energía positiva. Sin saludos ni despedidas, directo al grano.`,
        },
      ],
    });
    llmResponse = msg.content[0]?.text ?? null;
  } catch (err) {
    console.error('Gratitude LLM error:', err.message);
  }

  // Persist to DB
  try {
    await dbPool.query(
      `INSERT INTO gratitude_log (user_id, text, llm_response) VALUES ($1, $2, $3)`,
      [userId, trimmed, llmResponse],
    );
  } catch (err) {
    console.error('POST /gratitude DB error:', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }

  return res.json({ ok: true, response: llmResponse });
});

// GET /gratitude — retrieve the user's gratitude log (newest first)
gratitudeRouter.get('/gratitude', async (req, res) => {
  const userId = req.user.id;
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);

  try {
    const { rows } = await dbPool.query(
      `SELECT id, text, llm_response, created_at
       FROM gratitude_log
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [userId, limit],
    );
    return res.json({ entries: rows });
  } catch (err) {
    console.error('GET /gratitude error:', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default gratitudeRouter;
