import { Router } from 'express';
import { dbPool } from '../db/client.js';

const plannerRouter = Router();

// GET /planner/week?start=YYYY-MM-DD
// Returns week-specific slots merged with template (week-specific wins).
plannerRouter.get('/planner/week', async (req, res) => {
  const userId = req.user.id;
  const { start } = req.query;

  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return res.status(422).json({ error: 'validation_error', message: 'start (YYYY-MM-DD) es obligatorio.' });
  }

  try {
    const [weekResult, tmplResult] = await Promise.all([
      dbPool.query(
        `SELECT day_index, slot_time, content, color
         FROM weekly_planner WHERE user_id = $1 AND week_start = $2`,
        [userId, start]
      ),
      dbPool.query(
        `SELECT day_index, slot_time, content, color
         FROM planner_template WHERE user_id = $1`,
        [userId]
      )
    ]);
    return res.json({ slots: weekResult.rows, template: tmplResult.rows });
  } catch (err) {
    console.error('GET /planner/week error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PUT /planner/slot — upsert a single week-specific cell
plannerRouter.put('/planner/slot', async (req, res) => {
  const userId = req.user.id;
  const { week_start, day_index, slot_time, content = '', color = null } = req.body || {};

  if (!week_start || typeof day_index !== 'number' || !slot_time) {
    return res.status(422).json({ error: 'validation_error', message: 'week_start, day_index y slot_time son obligatorios.' });
  }

  try {
    if (!content && !color) {
      await dbPool.query(
        `DELETE FROM weekly_planner
         WHERE user_id = $1 AND week_start = $2 AND day_index = $3 AND slot_time = $4`,
        [userId, week_start, day_index, slot_time]
      );
    } else {
      await dbPool.query(
        `INSERT INTO weekly_planner (user_id, week_start, day_index, slot_time, content, color, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         ON CONFLICT (user_id, week_start, day_index, slot_time)
         DO UPDATE SET content = EXCLUDED.content, color = EXCLUDED.color, updated_at = now()`,
        [userId, week_start, day_index, slot_time, content.slice(0, 200) || null, color || null]
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('PUT /planner/slot error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /planner/template
plannerRouter.get('/planner/template', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `SELECT day_index, slot_time, content, color FROM planner_template WHERE user_id = $1`,
      [userId]
    );
    return res.json({ slots: rows });
  } catch (err) {
    console.error('GET /planner/template error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PUT /planner/template/slot — upsert a recurring template cell
plannerRouter.put('/planner/template/slot', async (req, res) => {
  const userId = req.user.id;
  const { day_index, slot_time, content = '', color = null } = req.body || {};

  if (typeof day_index !== 'number' || !slot_time) {
    return res.status(422).json({ error: 'validation_error', message: 'day_index y slot_time son obligatorios.' });
  }

  try {
    if (!content && !color) {
      await dbPool.query(
        `DELETE FROM planner_template WHERE user_id = $1 AND day_index = $2 AND slot_time = $3`,
        [userId, day_index, slot_time]
      );
    } else {
      await dbPool.query(
        `INSERT INTO planner_template (user_id, day_index, slot_time, content, color, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (user_id, day_index, slot_time)
         DO UPDATE SET content = EXCLUDED.content, color = EXCLUDED.color, updated_at = now()`,
        [userId, day_index, slot_time, content.slice(0, 200) || null, color || null]
      );
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('PUT /planner/template/slot error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /planner/slot-activity?week_start=YYYY-MM-DD
// Returns study minutes per day+hour for the given week (from activity_log).
plannerRouter.get('/planner/slot-activity', async (req, res) => {
  const userId = req.user.id;
  const { week_start } = req.query;

  if (!week_start || !/^\d{4}-\d{2}-\d{2}$/.test(week_start)) {
    return res.status(422).json({ error: 'validation_error', message: 'week_start (YYYY-MM-DD) es obligatorio.' });
  }

  try {
    // Group activity by day-of-week and hour (Argentina time) for the requested week
    const { rows } = await dbPool.query(
      `SELECT
         (logged_date - $2::date)::int AS day_index,
         EXTRACT(hour FROM (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int AS hour,
         ROUND(SUM(COALESCE(response_time_ms, 0)) / 60000.0)::int AS minutes,
         COUNT(*) AS reviews
       FROM activity_log
       WHERE user_id = $1
         AND logged_date >= $2::date
         AND logged_date < $2::date + 7
       GROUP BY day_index, hour
       ORDER BY day_index, hour`,
      [userId, week_start]
    );
    return res.json({ slots: rows });
  } catch (err) {
    console.error('GET /planner/slot-activity error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default plannerRouter;
