import { Router } from 'express';
import { pool } from '../db/client.js';

const router = Router();

router.get('/notes', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT content FROM user_notes WHERE user_id = $1',
      [req.user.id]
    );
    res.json({ content: rows[0]?.content ?? '' });
  } catch (err) {
    next(err);
  }
});

router.put('/notes', async (req, res, next) => {
  try {
    const content = typeof req.body.content === 'string' ? req.body.content : '';
    const { rows } = await pool.query(
      `INSERT INTO user_notes (user_id, content, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE
         SET content = EXCLUDED.content, updated_at = now()
       RETURNING content, updated_at`,
      [req.user.id, content]
    );
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
