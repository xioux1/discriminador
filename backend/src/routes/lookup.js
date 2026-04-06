import { Router } from 'express';
import { dbPool } from '../db/client.js';

const lookupRouter = Router();

lookupRouter.get('/subjects', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(`
      SELECT DISTINCT input_payload->>'subject' AS subject
      FROM evaluation_items
      WHERE source_system = 'evaluate_api'
        AND user_id = $1
        AND input_payload->>'subject' IS NOT NULL
        AND input_payload->>'subject' <> ''
      ORDER BY subject
    `, [userId]);
    return res.status(200).json({ subjects: rows.map((r) => r.subject) });
  } catch (error) {
    console.error('Failed to fetch subjects', { message: error.message });
    return res.status(500).json({ error: 'server_error', message: 'Failed to fetch subjects.' });
  }
});

lookupRouter.get('/expected-answer', async (req, res) => {
  const prompt = typeof req.query.prompt === 'string' ? req.query.prompt.trim() : '';
  const userId = req.user.id;

  if (prompt.length < 10) {
    return res.status(422).json({ error: 'validation_error', message: 'prompt must be at least 10 characters.' });
  }

  try {
    const { rows } = await dbPool.query(`
      SELECT input_payload->>'expected_answer_text' AS expected_answer_text,
             input_payload->>'subject'              AS subject
      FROM evaluation_items
      WHERE source_system = 'evaluate_api'
        AND user_id = $2
        AND trim(input_payload->>'prompt_text') = $1
        AND input_payload->>'expected_answer_text' IS NOT NULL
        AND input_payload->>'expected_answer_text' <> ''
      ORDER BY created_at DESC
      LIMIT 1
    `, [prompt, userId]);

    if (rows.length === 0) {
      return res.status(404).json({ found: false });
    }

    return res.status(200).json({
      found: true,
      expected_answer_text: rows[0].expected_answer_text,
      subject: rows[0].subject || null
    });
  } catch (error) {
    console.error('Failed to fetch expected answer', { message: error.message });
    return res.status(500).json({ error: 'server_error', message: 'Failed to fetch expected answer.' });
  }
});

export default lookupRouter;
