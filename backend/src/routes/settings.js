import { Router } from 'express';
import { dbPool } from '../db/client.js';

const settingsRouter = Router();

const DEFAULTS = {
  session_planning_enabled:   true,
  gratitude_enabled:          true,
  time_restriction_enabled:   true,
  planner_gate_enabled:       true,
  realtime_break_notifications_enabled: true,
  default_retention_floor:    null,
  default_grading_strictness: null,
};

// GET /settings — returns user settings (defaults if not yet saved)
settingsRouter.get('/settings', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `SELECT session_planning_enabled, gratitude_enabled, time_restriction_enabled,
              planner_gate_enabled, realtime_break_notifications_enabled,
              default_retention_floor, default_grading_strictness
       FROM user_settings WHERE user_id = $1`,
      [userId]
    );
    return res.json(rows.length === 0 ? { ...DEFAULTS } : rows[0]);
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
    planner_gate_enabled,
    realtime_break_notifications_enabled,
    default_retention_floor,
    default_grading_strictness,
  } = req.body || {};

  const toBool    = (v, fb) => (typeof v === 'boolean' ? v : fb);
  const toIntNull = (v, min, max) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };

  try {
    const { rows } = await dbPool.query(
      `INSERT INTO user_settings
         (user_id, session_planning_enabled, gratitude_enabled, time_restriction_enabled,
          planner_gate_enabled, realtime_break_notifications_enabled,
          default_retention_floor, default_grading_strictness, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
       ON CONFLICT (user_id) DO UPDATE SET
         session_planning_enabled   = EXCLUDED.session_planning_enabled,
         gratitude_enabled          = EXCLUDED.gratitude_enabled,
         time_restriction_enabled   = EXCLUDED.time_restriction_enabled,
         planner_gate_enabled       = EXCLUDED.planner_gate_enabled,
         realtime_break_notifications_enabled = EXCLUDED.realtime_break_notifications_enabled,
         default_retention_floor    = EXCLUDED.default_retention_floor,
         default_grading_strictness = EXCLUDED.default_grading_strictness,
         updated_at                 = now()
       RETURNING session_planning_enabled, gratitude_enabled, time_restriction_enabled,
                 planner_gate_enabled, realtime_break_notifications_enabled,
                 default_retention_floor, default_grading_strictness`,
      [
        userId,
        toBool(session_planning_enabled,   true),
        toBool(gratitude_enabled,          true),
        toBool(time_restriction_enabled,   true),
        toBool(planner_gate_enabled,       true),
        toBool(realtime_break_notifications_enabled, true),
        toIntNull(default_retention_floor,    50, 99),
        toIntNull(default_grading_strictness,  0, 10),
      ]
    );
    return res.json(rows[0]);
  } catch (err) {
    console.error('PUT /settings error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default settingsRouter;
