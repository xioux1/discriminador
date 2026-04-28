import { Router } from 'express';
import { dbPool } from '../db/client.js';

const router = Router();

const VALID_TYPES = ['clase', 'contenido', 'estudio_offline', 'reunion', 'otro'];

// GET /planner/manual-activity/active
// Returns the currently running session for the user (ended_at IS NULL), or null.
router.get('/planner/manual-activity/active', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `SELECT id, activity_type, subject, description, started_at
       FROM manual_activity_sessions
       WHERE user_id = $1 AND ended_at IS NULL
       ORDER BY started_at DESC
       LIMIT 1`,
      [userId]
    );
    return res.json({ session: rows[0] ?? null });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /planner/manual-activity
// Starts a new manual activity. Stops any previous unfinished session first.
router.post('/planner/manual-activity', async (req, res) => {
  const userId = req.user.id;
  const { activity_type, subject, description } = req.body ?? {};

  if (!VALID_TYPES.includes(activity_type)) {
    return res.status(422).json({
      error: 'validation_error',
      message: `activity_type must be one of: ${VALID_TYPES.join(', ')}.`,
    });
  }

  const cleanSubject     = typeof subject     === 'string' ? subject.trim().slice(0, 200)     : null;
  const cleanDescription = typeof description === 'string' ? description.trim().slice(0, 500) : null;

  try {
    // Close any open session before starting a new one
    await dbPool.query(
      `UPDATE manual_activity_sessions SET ended_at = now()
       WHERE user_id = $1 AND ended_at IS NULL`,
      [userId]
    );

    const { rows } = await dbPool.query(
      `INSERT INTO manual_activity_sessions (user_id, activity_type, subject, description, started_at)
       VALUES ($1, $2, $3, $4, now())
       RETURNING id, activity_type, subject, description, started_at`,
      [userId, activity_type, cleanSubject || null, cleanDescription || null]
    );

    return res.status(201).json({ session: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PATCH /planner/manual-activity/:id/stop
// Stops a running session by setting ended_at = now().
router.patch('/planner/manual-activity/:id/stop', async (req, res) => {
  const userId    = req.user.id;
  const sessionId = parseInt(req.params.id, 10);

  if (!Number.isFinite(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: 'invalid_id', message: 'Session ID must be a positive integer.' });
  }

  try {
    const { rows } = await dbPool.query(
      `UPDATE manual_activity_sessions
       SET ended_at = now()
       WHERE id = $1 AND user_id = $2 AND ended_at IS NULL
       RETURNING id, activity_type, subject, started_at, ended_at,
                 ROUND(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60)::int AS duration_minutes`,
      [sessionId, userId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Active session not found.' });
    }

    return res.json({ session: rows[0] });
  } catch (err) {
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default router;
