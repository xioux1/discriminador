import { Router } from 'express';
import { dbPool } from '../db/client.js';

const plannerRouter = Router();

// GET /planner/week?start=YYYY-MM-DD
// Returns all slots for the given week (sunday-based week_start), including fixed weekly templates.
plannerRouter.get('/planner/week', async (req, res) => {
  const userId = req.user.id;
  const { start } = req.query;

  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    return res.status(422).json({ error: 'validation_error', message: 'start (YYYY-MM-DD) es obligatorio.' });
  }

  try {
    const { rows } = await dbPool.query(
      `WITH fixed AS (
         SELECT day_index, slot_time, content, color, true AS is_fixed
         FROM weekly_planner_fixed
         WHERE user_id = $1
       ),
       week_slots AS (
         SELECT day_index, slot_time, content, color, false AS is_fixed
         FROM weekly_planner
         WHERE user_id = $1 AND week_start = $2
       )
       SELECT DISTINCT ON (day_index, slot_time)
              day_index, slot_time, content, color, is_fixed
       FROM (
         SELECT * FROM fixed
         UNION ALL
         SELECT * FROM week_slots
       ) merged
       ORDER BY day_index, slot_time, is_fixed ASC`,
      [userId, start]
    );
    const { rows: activityRows } = await dbPool.query(
      `WITH localized_activity AS (
         SELECT
           created_at AT TIME ZONE 'America/Argentina/Buenos_Aires' AS local_created_at,
           response_time_ms
         FROM activity_log
         WHERE user_id = $1
           AND activity_type IN ('study', 'evaluate')
       )
       SELECT
         EXTRACT(DOW FROM local_created_at)::int AS day_index,
         to_char(
           date_trunc('hour', local_created_at)
           + (CASE WHEN EXTRACT(MINUTE FROM local_created_at) >= 30 THEN INTERVAL '30 minutes' ELSE INTERVAL '0 minutes' END),
           'HH24:MI'
         ) AS slot_time,
         COUNT(*)::int AS events_count,
         ROUND(
           LEAST(30, COALESCE(SUM(response_time_ms), 0) / 60000.0)::numeric,
           1
         ) AS effective_minutes,
         MAX(local_created_at) AS last_event_at
       FROM localized_activity
       WHERE local_created_at >= $2::date
         AND local_created_at < ($2::date + INTERVAL '7 day')
       GROUP BY day_index, slot_time
       ORDER BY day_index, slot_time`,
      [userId, start]
    );

    return res.json({ slots: rows, activity_slots: activityRows });
  } catch (err) {
    console.error('GET /planner/week error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PUT /planner/slot — upsert a single cell
// Body: { week_start, day_index, slot_time, content, color, is_fixed }
plannerRouter.put('/planner/slot', async (req, res) => {
  const userId = req.user.id;
  const {
    week_start,
    day_index,
    slot_time,
    content = '',
    color = null,
    is_fixed = false
  } = req.body || {};

  if (!week_start || typeof day_index !== 'number' || !slot_time) {
    return res.status(422).json({ error: 'validation_error', message: 'week_start, day_index y slot_time son obligatorios.' });
  }

  const normalizedContent = content.slice(0, 200).trim();
  const normalizedColor = color || null;

  try {
    await dbPool.query('BEGIN');

    if (!normalizedContent && !normalizedColor) {
      await dbPool.query(
        `DELETE FROM weekly_planner
         WHERE user_id = $1 AND week_start = $2 AND day_index = $3 AND slot_time = $4`,
        [userId, week_start, day_index, slot_time]
      );
      await dbPool.query(
        `DELETE FROM weekly_planner_fixed
         WHERE user_id = $1 AND day_index = $2 AND slot_time = $3`,
        [userId, day_index, slot_time]
      );
    } else {
      if (is_fixed) {
        await dbPool.query(
          `INSERT INTO weekly_planner_fixed (user_id, day_index, slot_time, content, color, updated_at)
           VALUES ($1, $2, $3, $4, $5, now())
           ON CONFLICT (user_id, day_index, slot_time)
           DO UPDATE SET content = EXCLUDED.content, color = EXCLUDED.color, updated_at = now()`,
          [userId, day_index, slot_time, normalizedContent || null, normalizedColor]
        );
        await dbPool.query(
          `DELETE FROM weekly_planner
           WHERE user_id = $1 AND week_start = $2 AND day_index = $3 AND slot_time = $4`,
          [userId, week_start, day_index, slot_time]
        );
      } else {
        await dbPool.query(
          `DELETE FROM weekly_planner_fixed
           WHERE user_id = $1 AND day_index = $2 AND slot_time = $3`,
          [userId, day_index, slot_time]
        );
        await dbPool.query(
          `INSERT INTO weekly_planner (user_id, week_start, day_index, slot_time, content, color, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())
           ON CONFLICT (user_id, week_start, day_index, slot_time)
           DO UPDATE SET content = EXCLUDED.content, color = EXCLUDED.color, updated_at = now()`,
          [userId, week_start, day_index, slot_time, normalizedContent || null, normalizedColor]
        );
      }
    }

    await dbPool.query('COMMIT');
    return res.json({ ok: true });
  } catch (err) {
    await dbPool.query('ROLLBACK');
    console.error('PUT /planner/slot error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default plannerRouter;
