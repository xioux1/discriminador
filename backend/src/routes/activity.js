import { Router } from 'express';
import { dbPool } from '../db/client.js';

const activityRouter = Router();

/**
 * GET /stats/activity?days=365
 *
 * Returns daily activity counts for the heatmap + streak stats.
 * Merges evaluate-tab activity (user_decisions) with study-tab activity (activity_log).
 */
activityRouter.get('/stats/activity', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 365, 30), 730);
  const userId = req.user.id;

  try {
    // Combine evaluate activity + study activity into daily buckets.
    // Use a subquery for study_activity so a missing activity_log table
    // degrades gracefully (returns zeros) instead of crashing.
    const { rows } = await dbPool.query(
      `WITH tz_today AS (
         SELECT (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE AS today
       ),
       date_series AS (
         SELECT generate_series(
           (SELECT today FROM tz_today) - ($1::int - 1) * INTERVAL '1 day',
           (SELECT today FROM tz_today),
           INTERVAL '1 day'
         )::DATE AS d
       ),
       evaluate_activity AS (
         SELECT (decided_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE AS day,
                COUNT(*) AS cnt,
                COUNT(*) FILTER (WHERE final_grade = 'pass') AS pass_cnt
         FROM user_decisions
         WHERE (decided_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE
               BETWEEN (SELECT today FROM tz_today) - $1::int * INTERVAL '1 day'
                   AND (SELECT today FROM tz_today)
           AND user_id = $2
         GROUP BY 1
       ),
       study_activity AS (
         SELECT logged_date AS day, COUNT(*) AS cnt,
                COUNT(*) FILTER (WHERE grade = 'pass') AS pass_cnt
         FROM activity_log
         WHERE logged_date BETWEEN (SELECT today FROM tz_today) - $1::int * INTERVAL '1 day'
                               AND (SELECT today FROM tz_today)
           AND user_id = $2
         GROUP BY logged_date
       ),
       merged AS (
         SELECT ds.d AS day,
                COALESCE(e.cnt, 0) + COALESCE(s.cnt, 0) AS total,
                COALESCE(e.pass_cnt, 0) + COALESCE(s.pass_cnt, 0) AS pass_total
         FROM date_series ds
         LEFT JOIN evaluate_activity e ON e.day = ds.d
         LEFT JOIN study_activity s    ON s.day = ds.d
       )
       SELECT day, total, pass_total FROM merged ORDER BY day ASC`,
      [days, userId]
    );

    // Compute streaks
    let currentStreak = 0;
    let bestStreak = 0;
    let run = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (parseInt(rows[i].total) > 0) {
        run++;
        if (i === rows.length - 1 || parseInt(rows[i + 1].total) > 0) {
          currentStreak = run;
        }
        bestStreak = Math.max(bestStreak, run);
      } else {
        if (i === rows.length - 1) currentStreak = 0;
        run = 0;
      }
    }

    const totalReviews = rows.reduce((s, r) => s + parseInt(r.total), 0);

    return res.status(200).json({
      days: rows.map((r) => ({
        date: r.day,
        count: parseInt(r.total),
        pass_count: parseInt(r.pass_total)
      })),
      streak_current: currentStreak,
      streak_best: bestStreak,
      total_reviews: totalReviews
    });
  } catch (err) {
    // 42P01 = table does not exist (migration not yet applied)
    if (err.code === '42P01') {
      console.warn('GET /stats/activity: activity_log table missing, returning empty data');
      return res.status(200).json({
        days: [],
        streak_current: 0,
        streak_best: 0,
        total_reviews: 0
      });
    }
    console.error('GET /stats/activity', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default activityRouter;
