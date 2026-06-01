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
      `WITH session_spans AS (
         -- Compute local start/end for each completed session this week.
         -- span_minutes = real wall-clock duration; active_ratio scales each slot
         -- down to exclude pause time, since actual_minutes already omits pauses.
         SELECT
           actual_card_count,
           COALESCE(
             actual_minutes,
             LEAST(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0, 180)
           ) AS actual_minutes,
           started_at,
           (started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') AS local_start,
           -- For orphaned sessions (actual_minutes IS NULL), cap local_end at 3 hours past start
           (LEAST(
             COALESCE(ended_at, started_at + actual_minutes * INTERVAL '1 minute'),
             started_at + INTERVAL '3 hours'
           ) AT TIME ZONE 'America/Argentina/Buenos_Aires') AS local_end,
           GREATEST(
             COALESCE(actual_minutes, 0),
             LEAST(
               EXTRACT(EPOCH FROM (
                 COALESCE(ended_at, started_at + actual_minutes * INTERVAL '1 minute') - started_at
               )) / 60.0,
               180
             )
           ) AS span_minutes
         FROM study_sessions
         WHERE user_id = $1
           AND (actual_minutes IS NOT NULL OR ended_at IS NOT NULL)
           AND (started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') >= $2::date
           AND (started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') < ($2::date + INTERVAL '7 day')
       ),
       session_slots AS (
         -- Expand each session across every 30-min slot it overlaps and compute
         -- how many active minutes of that session fall within each slot.
         -- The overlap is scaled by (actual_minutes / span_minutes) to strip pauses.
         SELECT
           EXTRACT(DOW FROM gs)::int AS day_index,
           to_char(gs, 'HH24:MI') AS slot_time,
           SUM(s.actual_card_count)::int AS events_count,
           ROUND(SUM(
             GREATEST(0,
               EXTRACT(EPOCH FROM (
                 LEAST(s.local_end, gs + INTERVAL '30 minutes')
                 - GREATEST(s.local_start, gs)
               )) / 60.0
             ) * (s.actual_minutes / s.span_minutes)
           ))::int AS study_minutes,
           MAX(s.started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') AS last_event_at
         FROM session_spans s
         CROSS JOIN LATERAL generate_series(
           date_trunc('hour', s.local_start)
             + (CASE WHEN EXTRACT(MINUTE FROM s.local_start) >= 30 THEN INTERVAL '30 minutes' ELSE INTERVAL '0' END),
           date_trunc('hour', s.local_end)
             + (CASE WHEN EXTRACT(MINUTE FROM s.local_end) >= 30 THEN INTERVAL '30 minutes' ELSE INTERVAL '0' END),
           INTERVAL '30 minutes'
         ) AS gs
         WHERE LEAST(s.local_end, gs + INTERVAL '30 minutes') > GREATEST(s.local_start, gs)
         GROUP BY day_index, slot_time
       ),
       activity_slots AS (
         SELECT
           EXTRACT(DOW FROM (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int AS day_index,
           to_char(
             date_trunc('hour', created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')
             + (CASE WHEN EXTRACT(MINUTE FROM created_at AT TIME ZONE 'America/Argentina/Buenos_Aires') >= 30 THEN INTERVAL '30 minutes' ELSE INTERVAL '0 minutes' END),
             'HH24:MI'
           ) AS slot_time,
           COUNT(*)::int AS events_count,
           MAX(created_at AT TIME ZONE 'America/Argentina/Buenos_Aires') AS last_event_at
         FROM activity_log
         WHERE user_id = $1
           AND activity_type IN ('study', 'evaluate')
           AND (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires') >= $2::date
           AND (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires') < ($2::date + INTERVAL '7 day')
         GROUP BY day_index, slot_time
       )
       SELECT
         COALESCE(s.day_index,     a.day_index)     AS day_index,
         COALESCE(s.slot_time,     a.slot_time)     AS slot_time,
         COALESCE(s.events_count,  a.events_count)  AS events_count,
         COALESCE(s.study_minutes, 0)               AS study_minutes,
         COALESCE(s.last_event_at, a.last_event_at) AS last_event_at
       FROM activity_slots a
       FULL OUTER JOIN session_slots s USING (day_index, slot_time)
       ORDER BY day_index, slot_time`,
      [userId, start]
    );

    // Per-day, per-subject breakdown using full session time proportionally distributed by subject.
    // Distributes each session's actual_minutes across subjects in proportion to card response
    // time, so that time between cards, reviewing answers, etc. is included.
    const { rows: subjectRows } = await dbPool.query(
      `WITH card_per_session_subject AS (
         SELECT
           ss.id                                                                           AS session_id,
           EXTRACT(DOW FROM (ss.started_at AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int AS day_index,
           COALESCE(
             ss.actual_minutes,
             LEAST(EXTRACT(EPOCH FROM (ss.ended_at - ss.started_at)) / 60.0, 180)
           )                                                                               AS eff_minutes,
           COALESCE(NULLIF(TRIM(al.subject), ''), 'Sin materia')                           AS subject,
           SUM(COALESCE(al.response_time_ms, 0) + COALESCE(al.review_time_ms, 0))         AS subject_card_ms
         FROM study_sessions ss
         JOIN activity_log al
           ON  al.user_id        = ss.user_id
           AND al.activity_type IN ('study', 'evaluate')
           AND al.created_at    >= ss.started_at
           AND al.created_at    <= COALESCE(ss.ended_at, ss.started_at + INTERVAL '3 hours')
         WHERE ss.user_id = $1
           AND (ss.actual_minutes IS NOT NULL OR ss.ended_at IS NOT NULL)
           AND (ss.started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') >= $2::date
           AND (ss.started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') < ($2::date + INTERVAL '7 day')
         GROUP BY ss.id, ss.actual_minutes, ss.ended_at, ss.started_at, al.subject
       ),
       session_total_card_ms AS (
         SELECT session_id, SUM(subject_card_ms) AS total_card_ms
         FROM card_per_session_subject
         GROUP BY session_id
       )
       SELECT
         cpss.day_index,
         cpss.subject,
         ROUND(SUM(
           cpss.eff_minutes * cpss.subject_card_ms / NULLIF(stcm.total_card_ms, 0)
         ))::int AS study_minutes
       FROM card_per_session_subject cpss
       JOIN session_total_card_ms stcm ON stcm.session_id = cpss.session_id
       WHERE stcm.total_card_ms > 0
       GROUP BY cpss.day_index, cpss.subject
       HAVING ROUND(SUM(
         cpss.eff_minutes * cpss.subject_card_ms / NULLIF(stcm.total_card_ms, 0)
       ))::int > 0
       ORDER BY cpss.day_index, study_minutes DESC`,
      [userId, start]
    );

    // Manual activity sessions expanded across 30-min slots (same logic as study_sessions)
    const { rows: manualRows } = await dbPool.query(
      `WITH manual_spans AS (
         SELECT
           activity_type,
           subject,
           (started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') AS local_start,
           (ended_at    AT TIME ZONE 'America/Argentina/Buenos_Aires') AS local_end
         FROM manual_activity_sessions
         WHERE user_id = $1
           AND ended_at IS NOT NULL
           AND (started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') >= $2::date
           AND (started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') < ($2::date + INTERVAL '7 day')
       ),
       manual_slots AS (
         SELECT
           EXTRACT(DOW FROM gs)::int                AS day_index,
           to_char(gs, 'HH24:MI')                   AS slot_time,
           s.activity_type,
           s.subject,
           ROUND(SUM(
             GREATEST(0,
               EXTRACT(EPOCH FROM (
                 LEAST(s.local_end, gs + INTERVAL '30 minutes')
                 - GREATEST(s.local_start, gs)
               )) / 60.0
             )
           ))::int AS duration_minutes
         FROM manual_spans s
         CROSS JOIN LATERAL generate_series(
           date_trunc('hour', s.local_start)
             + (CASE WHEN EXTRACT(MINUTE FROM s.local_start) >= 30 THEN INTERVAL '30 minutes' ELSE INTERVAL '0' END),
           date_trunc('hour', s.local_end)
             + (CASE WHEN EXTRACT(MINUTE FROM s.local_end) >= 30 THEN INTERVAL '30 minutes' ELSE INTERVAL '0' END),
           INTERVAL '30 minutes'
         ) AS gs
         WHERE LEAST(s.local_end, gs + INTERVAL '30 minutes') > GREATEST(s.local_start, gs)
         GROUP BY gs, s.activity_type, s.subject
       )
       SELECT * FROM manual_slots WHERE duration_minutes > 0
       ORDER BY day_index, slot_time, activity_type`,
      [userId, start]
    );

    return res.json({
      slots: rows,
      activity_slots: activityRows,
      daily_subject_totals: subjectRows,
      manual_slots: manualRows,
    });
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

// GET /planner/day-status
// Returns whether today's planner column is fully filled (all 32 slots covered).
// "Today" is computed in America/Argentina/Buenos_Aires timezone.
plannerRouter.get('/planner/day-status', async (req, res) => {
  const userId = req.user.id;
  const TOTAL_SLOTS = 34; // 05:00–21:30, one slot every 30 min

  try {
    const { rows } = await dbPool.query(
      `WITH today_info AS (
         SELECT
           (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date                      AS today,
           EXTRACT(DOW FROM (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int      AS day_index
       ),
       bounds AS (
         SELECT today - day_index::int AS week_start, day_index FROM today_info
       ),
       filled_slots AS (
         SELECT slot_time FROM weekly_planner_fixed
           WHERE user_id = $1 AND day_index = (SELECT day_index FROM bounds)
         UNION
         SELECT slot_time FROM weekly_planner
           WHERE user_id = $1
             AND week_start = (SELECT week_start FROM bounds)
             AND day_index  = (SELECT day_index  FROM bounds)
       )
       SELECT COUNT(DISTINCT slot_time)::int AS filled FROM filled_slots`,
      [userId]
    );

    const filled = rows[0]?.filled ?? 0;
    return res.json({ is_full: filled >= TOTAL_SLOTS, filled, total: TOTAL_SLOTS });
  } catch (err) {
    console.error('GET /planner/day-status error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ─── Planner To-do list ───────────────────────────────────────────────────────

// GET /planner/todos
plannerRouter.get('/planner/todos', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      'SELECT id, text, done, position FROM planner_todos WHERE user_id = $1 ORDER BY position ASC, id ASC',
      [userId]
    );
    return res.json({ todos: rows });
  } catch (err) {
    console.error('GET /planner/todos error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /planner/todos — create
plannerRouter.post('/planner/todos', async (req, res) => {
  const userId = req.user.id;
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(422).json({ error: 'validation_error', message: 'text is required.' });
  try {
    const { rows } = await dbPool.query(
      `INSERT INTO planner_todos (user_id, text, position)
       VALUES ($1, $2, (SELECT COALESCE(MAX(position), 0) + 1 FROM planner_todos WHERE user_id = $1))
       RETURNING id, text, done, position`,
      [userId, text.slice(0, 500)]
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /planner/todos error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PATCH /planner/todos/:id — update text or done
plannerRouter.patch('/planner/todos/:id', async (req, res) => {
  const userId = req.user.id;
  const id = Number(req.params.id);
  const { text, done } = req.body || {};
  if (!Number.isFinite(id)) return res.status(422).json({ error: 'validation_error', message: 'invalid id.' });
  try {
    const sets = [];
    const params = [id, userId];
    if (typeof text === 'string') { params.push(text.trim().slice(0, 500)); sets.push(`text = $${params.length}`); }
    if (typeof done === 'boolean') { params.push(done); sets.push(`done = $${params.length}`); }
    if (!sets.length) return res.status(422).json({ error: 'validation_error', message: 'nothing to update.' });
    sets.push('updated_at = now()');
    const { rows } = await dbPool.query(
      `UPDATE planner_todos SET ${sets.join(', ')} WHERE id = $1 AND user_id = $2 RETURNING id, text, done, position`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /planner/todos/:id error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// DELETE /planner/todos/:id
plannerRouter.delete('/planner/todos/:id', async (req, res) => {
  const userId = req.user.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(422).json({ error: 'validation_error', message: 'invalid id.' });
  try {
    await dbPool.query('DELETE FROM planner_todos WHERE id = $1 AND user_id = $2', [id, userId]);
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /planner/todos/:id error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /planner/today-schedule
// Returns today's non-empty planner slots ordered by slot_time, for planner-enforced study sessions.
plannerRouter.get('/planner/today-schedule', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `WITH today_info AS (
         SELECT
           (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::date                     AS today,
           EXTRACT(DOW FROM (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires'))::int    AS day_index
       ),
       bounds AS (
         SELECT today - day_index::int AS week_start, day_index FROM today_info
       ),
       fixed AS (
         SELECT slot_time, content, color, true AS is_fixed
         FROM weekly_planner_fixed, bounds
         WHERE user_id = $1 AND weekly_planner_fixed.day_index = bounds.day_index
           AND content IS NOT NULL AND TRIM(content) != ''
       ),
       week_slots AS (
         SELECT slot_time, content, color, false AS is_fixed
         FROM weekly_planner, bounds
         WHERE user_id = $1 AND weekly_planner.week_start = bounds.week_start AND weekly_planner.day_index = bounds.day_index
           AND content IS NOT NULL AND TRIM(content) != ''
       )
       SELECT DISTINCT ON (slot_time) slot_time, content, color
       FROM (
         SELECT * FROM week_slots
         UNION ALL
         SELECT * FROM fixed
       ) merged
       ORDER BY slot_time, is_fixed ASC`,
      [userId]
    );
    return res.json({ slots: rows });
  } catch (err) {
    console.error('GET /planner/today-schedule error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /planner/calendar-events?year=YYYY&month=MM
// Returns exam dates + custom events for a calendar month.
plannerRouter.get('/planner/calendar-events', async (req, res) => {
  const userId = req.user.id;
  const { year, month } = req.query;
  const y = parseInt(year, 10);
  const m = parseInt(month, 10); // 1-12
  if (!year || !month || isNaN(y) || isNaN(m) || m < 1 || m > 12) {
    return res.status(422).json({ error: 'validation_error', message: 'year y month (1-12) son obligatorios.' });
  }
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const nextMonthStart = m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  try {
    const { rows: exams } = await dbPool.query(
      `SELECT id, subject, label, exam_date, exam_type
       FROM subject_exam_dates
       WHERE user_id = $1 AND exam_date >= $2 AND exam_date < $3
       ORDER BY exam_date ASC`,
      [userId, monthStart, nextMonthStart]
    );
    const { rows: events } = await dbPool.query(
      `SELECT id, title, event_date, color
       FROM planner_calendar_events
       WHERE user_id = $1 AND event_date >= $2 AND event_date < $3
       ORDER BY event_date ASC`,
      [userId, monthStart, nextMonthStart]
    );
    const { rows: studyTotals } = await dbPool.query(
      `WITH session_daily AS (
         SELECT
           DATE(started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') AS study_date,
           SUM(COALESCE(
             actual_minutes,
             LEAST(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0, 180)
           )) AS study_minutes
         FROM study_sessions
         WHERE user_id = $1
           AND (actual_minutes IS NOT NULL OR ended_at IS NOT NULL)
           AND DATE(started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') >= $2
           AND DATE(started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') < $3
         GROUP BY study_date
       ),
       manual_daily AS (
         SELECT
           DATE(started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') AS study_date,
           SUM(ROUND(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0)) AS study_minutes
         FROM manual_activity_sessions
         WHERE user_id = $1
           AND ended_at IS NOT NULL
           AND DATE(started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') >= $2
           AND DATE(started_at AT TIME ZONE 'America/Argentina/Buenos_Aires') < $3
         GROUP BY study_date
       )
       SELECT
         COALESCE(s.study_date, m.study_date) AS study_date,
         ROUND(COALESCE(s.study_minutes, 0) + COALESCE(m.study_minutes, 0))::int AS study_minutes
       FROM session_daily s
       FULL OUTER JOIN manual_daily m USING (study_date)
       ORDER BY study_date`,
      [userId, monthStart, nextMonthStart]
    );
    return res.json({ exams, events, study_totals: studyTotals });
  } catch (err) {
    console.error('GET /planner/calendar-events error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /planner/calendar-events — create a custom calendar event
plannerRouter.post('/planner/calendar-events', async (req, res) => {
  const userId = req.user.id;
  const { title, event_date, color } = req.body || {};
  if (!title || !String(title).trim()) {
    return res.status(422).json({ error: 'validation_error', message: 'title es obligatorio.' });
  }
  if (!event_date || !/^\d{4}-\d{2}-\d{2}$/.test(event_date)) {
    return res.status(422).json({ error: 'validation_error', message: 'event_date (YYYY-MM-DD) es obligatorio.' });
  }
  const safeColor = /^#[0-9a-fA-F]{3,6}$/.test(color || '') ? color : '#c9daf8';
  try {
    const { rows } = await dbPool.query(
      `INSERT INTO planner_calendar_events (user_id, title, event_date, color)
       VALUES ($1, $2, $3, $4)
       RETURNING id, title, event_date, color`,
      [userId, String(title).trim().substring(0, 200), event_date, safeColor]
    );
    return res.json({ event: rows[0] });
  } catch (err) {
    console.error('POST /planner/calendar-events error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// DELETE /planner/calendar-events/:id
plannerRouter.delete('/planner/calendar-events/:id', async (req, res) => {
  const userId = req.user.id;
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    return res.status(422).json({ error: 'validation_error', message: 'id inválido.' });
  }
  try {
    await dbPool.query(
      'DELETE FROM planner_calendar_events WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /planner/calendar-events error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default plannerRouter;
