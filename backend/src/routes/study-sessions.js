import { Router } from 'express';
import { dbPool } from '../db/client.js';

const studySessionsRouter = Router();

// POST /study/sessions — record session start, return session_id
studySessionsRouter.post('/study/sessions', async (req, res) => {
  const userId = req.user.id;
  const { planned_minutes, planned_card_count, energy_level } = req.body || {};

  if (planned_minutes == null || typeof planned_minutes !== 'number' || planned_minutes < 0) {
    return res.status(422).json({ error: 'validation_error', message: 'planned_minutes es obligatorio.' });
  }

  try {
    // Close any orphaned sessions from this user (started in the last 24h, never completed)
    await dbPool.query(
      `UPDATE study_sessions
       SET ended_at = now(),
           actual_minutes = GREATEST(0, EXTRACT(EPOCH FROM (now() - started_at)) / 60.0)
       WHERE user_id = $1
         AND actual_minutes IS NULL
         AND ended_at IS NULL
         AND started_at >= now() - INTERVAL '24 hours'`,
      [userId]
    );
    const { rows } = await dbPool.query(
      `INSERT INTO study_sessions (user_id, planned_minutes, planned_card_count, energy_level)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, planned_minutes, planned_card_count || 0, energy_level || null]
    );
    return res.status(201).json({ session_id: rows[0].id });
  } catch (err) {
    console.error('POST /study/sessions error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PATCH /study/sessions/:id — record session completion
studySessionsRouter.patch('/study/sessions/:id', async (req, res) => {
  const userId    = req.user.id;
  const sessionId = parseInt(req.params.id, 10);
  const { actual_minutes, actual_card_count } = req.body || {};

  if (!Number.isFinite(sessionId)) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  try {
    await dbPool.query(
      `UPDATE study_sessions
       SET actual_minutes = $1, actual_card_count = $2, ended_at = now()
       WHERE id = $3 AND user_id = $4`,
      [actual_minutes ?? null, actual_card_count ?? 0, sessionId, userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /study/sessions/:id error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /study/sessions/calibration — per-user calibration factor from last 10 sessions
studySessionsRouter.get('/study/sessions/calibration', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `SELECT
         COUNT(*)::int AS sessions_used,
         ROUND(AVG(actual_minutes)::numeric, 2) AS avg_actual_minutes,
         ROUND(AVG(planned_minutes)::numeric, 2) AS avg_planned_minutes,
         CASE
           WHEN COUNT(*) >= 3
           THEN GREATEST(0.5, LEAST(2.0,
                  AVG(actual_minutes::numeric / NULLIF(planned_minutes, 0))
                ))::numeric(4,3)
           ELSE 1.0
         END AS calibration_factor
       FROM (
         SELECT actual_minutes, planned_minutes
         FROM study_sessions
         WHERE user_id = $1
           AND actual_minutes IS NOT NULL
           AND planned_minutes > 0
         ORDER BY ended_at DESC
         LIMIT 10
       ) recent`,
      [userId]
    );
    const row = rows[0];
    return res.json({
      calibration_factor:  Number(row.calibration_factor),
      sessions_used:       Number(row.sessions_used),
      avg_actual_minutes:  row.avg_actual_minutes  ? Number(row.avg_actual_minutes)  : null,
      avg_planned_minutes: row.avg_planned_minutes ? Number(row.avg_planned_minutes) : null,
    });
  } catch (err) {
    console.error('GET /study/sessions/calibration error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default studySessionsRouter;
