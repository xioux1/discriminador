import { Router } from 'express';
import { dbPool } from '../db/client.js';

const settingsRouter = Router();

// GET /settings — returns user settings (defaults if not yet saved)
settingsRouter.get('/settings', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      'SELECT session_planning_enabled, gratitude_enabled, time_restriction_enabled FROM user_settings WHERE user_id = $1',
      [userId]
    );
    if (rows.length === 0) {
      return res.json({
        session_planning_enabled: true,
        gratitude_enabled: true,
        time_restriction_enabled: true,
      });
    }
    return res.json(rows[0]);
  } catch (err) {
    console.error('GET /settings error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PUT /settings — upsert user settings
settingsRouter.put('/settings', async (req, res) => {
  const userId = req.user.id;
  const {
    session_planning_enabled,
    gratitude_enabled,
    time_restriction_enabled,
  } = req.body || {};

  const toBoolean = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

  try {
    const { rows } = await dbPool.query(
      `INSERT INTO user_settings (user_id, session_planning_enabled, gratitude_enabled, time_restriction_enabled, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE SET
         session_planning_enabled = EXCLUDED.session_planning_enabled,
         gratitude_enabled        = EXCLUDED.gratitude_enabled,
         time_restriction_enabled = EXCLUDED.time_restriction_enabled,
         updated_at               = now()
       RETURNING session_planning_enabled, gratitude_enabled, time_restriction_enabled`,
      [
        userId,
        toBoolean(session_planning_enabled, true),
        toBoolean(gratitude_enabled, true),
        toBoolean(time_restriction_enabled, true),
      ]
    );
    return res.json(rows[0]);
  } catch (err) {
    console.error('PUT /settings error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default settingsRouter;
