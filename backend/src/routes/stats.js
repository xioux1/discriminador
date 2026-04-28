import { Router } from 'express';
import { dbPool } from '../db/client.js';

const statsRouter = Router();

statsRouter.get('/stats/question', async (req, res) => {
  const prompt = typeof req.query.prompt === 'string' ? req.query.prompt.trim() : '';
  const userId = req.user.id;

  if (prompt.length < 10) {
    return res.status(422).json({ error: 'validation_error', message: 'prompt must be at least 10 characters.' });
  }

  try {
    const { rows } = await dbPool.query(`
      SELECT
        ei.id,
        ei.created_at,
        ud.final_grade,
        ud.decision_type,
        ud.reason        AS correction_reason,
        ud.decided_at,
        (ei.evaluator_context->>'overall_score')::numeric   AS overall_score,
        ei.evaluator_context->'dimensions'                  AS dimensions,
        ei.evaluator_context->>'justification_short'        AS justification
      FROM evaluation_items ei
      LEFT JOIN LATERAL (
        SELECT final_grade, decision_type, reason, decided_at
        FROM user_decisions
        WHERE evaluation_item_id = ei.id
        ORDER BY decided_at DESC
        LIMIT 1
      ) ud ON true
      WHERE ei.source_system = 'evaluate_api'
        AND ei.user_id = $2
        AND trim(ei.input_payload->>'prompt_text') = $1
        AND ud.final_grade IS NOT NULL
      ORDER BY COALESCE(ud.decided_at, ei.created_at) DESC
      LIMIT 20
    `, [prompt, userId]);

    if (rows.length === 0) {
      return res.status(200).json({ total: 0, history: [] });
    }

    const total = rows.length;
    const passCount = rows.filter((r) => ['pass', 'good', 'easy'].includes(r.final_grade)).length;
    const failCount = rows.filter((r) => ['fail', 'again', 'hard'].includes(r.final_grade)).length;

    // Dimension weakness: average score per dimension across all rows that have dimension data
    const dimTotals = {};
    const dimCounts = {};
    const dimFailCounts = {};

    for (const row of rows) {
      if (!row.dimensions) continue;
      for (const [dim, val] of Object.entries(row.dimensions)) {
        const v = Number(val);
        dimTotals[dim] = (dimTotals[dim] || 0) + v;
        dimCounts[dim] = (dimCounts[dim] || 0) + 1;
        if (v < 0.5) dimFailCounts[dim] = (dimFailCounts[dim] || 0) + 1;
      }
    }

    const dimensionStats = Object.keys(dimTotals).map((dim) => ({
      dimension: dim,
      avg_score: Number((dimTotals[dim] / dimCounts[dim]).toFixed(2)),
      fail_count: dimFailCounts[dim] || 0,
      total: dimCounts[dim]
    })).sort((a, b) => a.avg_score - b.avg_score);

    // Trend: compare last 3 vs previous 3
    let trend = 'insufficient_data';
    if (rows.length >= 4) {
      const recent = rows.slice(0, 3).filter((r) => ['pass', 'good', 'easy'].includes(r.final_grade)).length;
      const older  = rows.slice(3, 6).filter((r) => ['pass', 'good', 'easy'].includes(r.final_grade)).length;
      const recentTotal = Math.min(3, rows.length);
      const olderTotal  = Math.min(3, Math.max(0, rows.length - 3));
      if (olderTotal === 0) {
        trend = 'insufficient_data';
      } else {
        const recentRate = recent / recentTotal;
        const olderRate  = older / olderTotal;
        if (recentRate > olderRate + 0.15) trend = 'improving';
        else if (recentRate < olderRate - 0.15) trend = 'declining';
        else trend = 'stable';
      }
    }

    // Observations: LLM justification for every evaluation + correction reason when user corrected
    const observations = rows.slice(0, 10).map((r) => ({
      grade: r.final_grade,
      source: r.decision_type === 'corrected' && r.correction_reason ? 'user' : 'llm',
      text: (r.decision_type === 'corrected' && r.correction_reason)
        ? r.correction_reason
        : r.justification || null
    })).filter((o) => o.text);

    const history = rows.slice(0, 10).map((r) => ({
      final_grade: r.final_grade,
      decision_type: r.decision_type,
      correction_reason: r.correction_reason || null,
      justification: r.justification || null,
      overall_score: r.overall_score ? Number(r.overall_score) : null,
      decided_at: r.decided_at || r.created_at
    }));

    return res.status(200).json({
      total,
      pass_count: passCount,
      fail_count: failCount,
      pass_rate: Number((passCount / total).toFixed(2)),
      last_grade: rows[0].final_grade,
      trend,
      dimension_stats: dimensionStats,
      observations,
      history
    });
  } catch (error) {
    console.error('Failed to fetch question stats', { message: error.message });
    return res.status(500).json({ error: 'server_error', message: 'Failed to fetch stats.' });
  }
});

// GET /stats/timing?weeks=4 — response time trends per subject and slowest cards
statsRouter.get('/stats/timing', async (req, res) => {
  const userId = req.user.id;
  const weeks = Math.min(12, Math.max(1, parseInt(req.query.weeks, 10) || 4));

  try {
    // Weekly averages per subject from activity_log
    const subjectRows = await dbPool.query(
      `SELECT
         subject,
         date_trunc('week', logged_date::timestamptz)::date AS week_start,
         ROUND(AVG(response_time_ms))::int AS avg_ms,
         ROUND(AVG(review_time_ms))::int   AS avg_review_ms,
         COUNT(*) AS cnt
       FROM activity_log
       WHERE user_id = $1
         AND response_time_ms IS NOT NULL
         AND subject IS NOT NULL
         AND logged_date BETWEEN (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE - ($2::int * 7)
                             AND (NOW() AT TIME ZONE 'America/Argentina/Buenos_Aires')::DATE
       GROUP BY subject, week_start
       ORDER BY subject ASC, week_start ASC`,
      [userId, weeks]
    );

    // Group by subject
    const bySubjectMap = {};
    for (const row of subjectRows.rows) {
      if (!bySubjectMap[row.subject]) bySubjectMap[row.subject] = [];
      bySubjectMap[row.subject].push({
        week_start: row.week_start,
        avg_ms: Number(row.avg_ms),
        avg_review_ms: row.avg_review_ms ? Number(row.avg_review_ms) : null,
        count: Number(row.cnt)
      });
    }
    const by_subject = Object.entries(bySubjectMap).map(([subject, weeks]) => ({ subject, weeks }));

    // Top 20 slowest cards (by rolling average already maintained on cards table)
    const cardRows = await dbPool.query(
      `SELECT id AS card_id, prompt_text, subject,
              avg_response_time_ms AS avg_ms,
              avg_review_time_ms   AS avg_review_ms
       FROM cards
       WHERE user_id = $1
         AND avg_response_time_ms IS NOT NULL
       ORDER BY avg_response_time_ms DESC
       LIMIT 20`,
      [userId]
    );
    const by_card = cardRows.rows.map(r => ({
      card_id: r.card_id,
      prompt_text: r.prompt_text,
      subject: r.subject,
      avg_ms: Number(r.avg_ms),
      avg_review_ms: r.avg_review_ms ? Number(r.avg_review_ms) : null
    }));

    return res.json({ by_subject, by_card });
  } catch (err) {
    console.error('GET /stats/timing error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /stats/weekly — weekly study summary for current week + 8-week trend
statsRouter.get('/stats/weekly', async (req, res) => {
  const userId = req.user.id;
  const TZ = 'America/Argentina/Buenos_Aires';

  try {
    // Current ISO week start (Monday) in local time
    const { rows: nowRows } = await dbPool.query(
      `SELECT (date_trunc('week', NOW() AT TIME ZONE $1))::date AS week_start`,
      [TZ]
    );
    const thisWeekStart = nowRows[0].week_start; // YYYY-MM-DD string
    const weDate = new Date(thisWeekStart + 'T00:00:00Z');
    weDate.setUTCDate(weDate.getUTCDate() + 7);
    const thisWeekEnd = weDate.toISOString().slice(0, 10);

    // Activity log study time + review counts per subject (current week)
    const { rows: alRows } = await dbPool.query(
      `SELECT
         COALESCE(NULLIF(TRIM(subject), ''), 'Sin materia') AS subject,
         ROUND(SUM(COALESCE(response_time_ms, 0) + COALESCE(review_time_ms, 0)) / 60000.0)::int AS minutes,
         COUNT(*)::int AS review_count
       FROM activity_log
       WHERE user_id = $1
         AND activity_type IN ('study', 'evaluate')
         AND (created_at AT TIME ZONE $2)::date >= $3::date
         AND (created_at AT TIME ZONE $2)::date <  $4::date
       GROUP BY subject
       ORDER BY minutes DESC`,
      [userId, TZ, thisWeekStart, thisWeekEnd]
    );

    // Manual activity sessions by type + subject (current week)
    const { rows: maRows } = await dbPool.query(
      `SELECT
         activity_type,
         COALESCE(NULLIF(TRIM(subject), ''), NULL) AS subject,
         ROUND(SUM(EXTRACT(EPOCH FROM (ended_at - started_at)) / 60.0))::int AS minutes
       FROM manual_activity_sessions
       WHERE user_id = $1
         AND ended_at IS NOT NULL
         AND (started_at AT TIME ZONE $2)::date >= $3::date
         AND (started_at AT TIME ZONE $2)::date <  $4::date
       GROUP BY activity_type, subject
       ORDER BY minutes DESC`,
      [userId, TZ, thisWeekStart, thisWeekEnd]
    );

    // Active dates this week (union of all activity sources)
    const { rows: activeDateRows } = await dbPool.query(
      `SELECT DISTINCT active_date::text FROM (
         SELECT (created_at AT TIME ZONE $2)::date AS active_date
         FROM activity_log
         WHERE user_id = $1 AND activity_type IN ('study','evaluate')
           AND (created_at AT TIME ZONE $2)::date >= $3::date
           AND (created_at AT TIME ZONE $2)::date <  $4::date
         UNION
         SELECT (started_at AT TIME ZONE $2)::date
         FROM manual_activity_sessions
         WHERE user_id = $1 AND ended_at IS NOT NULL
           AND (started_at AT TIME ZONE $2)::date >= $3::date
           AND (started_at AT TIME ZONE $2)::date <  $4::date
       ) t`,
      [userId, TZ, thisWeekStart, thisWeekEnd]
    );

    // 8-week trend (oldest to newest)
    const { rows: trendRows } = await dbPool.query(
      `WITH weeks AS (
         SELECT generate_series(7, 0, -1) AS w_offset
       ),
       week_starts AS (
         SELECT
           w_offset,
           (date_trunc('week', NOW() AT TIME ZONE $2) - (w_offset * INTERVAL '7 days'))::date AS ws,
           (date_trunc('week', NOW() AT TIME ZONE $2) - (w_offset * INTERVAL '7 days') + INTERVAL '7 days')::date AS we
         FROM weeks
       ),
       al_by_week AS (
         SELECT
           ws.w_offset,
           COALESCE(ROUND(SUM(COALESCE(al.response_time_ms,0)+COALESCE(al.review_time_ms,0))/60000.0)::int, 0) AS study_minutes,
           COALESCE(COUNT(al.id)::int, 0) AS review_count
         FROM week_starts ws
         LEFT JOIN activity_log al
           ON al.user_id = $1
           AND al.activity_type IN ('study','evaluate')
           AND (al.created_at AT TIME ZONE $2)::date >= ws.ws
           AND (al.created_at AT TIME ZONE $2)::date <  ws.we
         GROUP BY ws.w_offset
       ),
       ma_by_week AS (
         SELECT
           ws.w_offset,
           COALESCE(ROUND(SUM(EXTRACT(EPOCH FROM (ma.ended_at - ma.started_at))/60.0))::int, 0) AS manual_minutes
         FROM week_starts ws
         LEFT JOIN manual_activity_sessions ma
           ON ma.user_id = $1
           AND ma.ended_at IS NOT NULL
           AND (ma.started_at AT TIME ZONE $2)::date >= ws.ws
           AND (ma.started_at AT TIME ZONE $2)::date <  ws.we
         GROUP BY ws.w_offset
       )
       SELECT
         ws.ws::text AS week_start,
         COALESCE(al.study_minutes,  0) AS study_minutes,
         COALESCE(al.review_count,   0) AS review_count,
         COALESCE(ma.manual_minutes, 0) AS manual_minutes,
         COALESCE(al.study_minutes, 0) + COALESCE(ma.manual_minutes, 0) AS total_minutes
       FROM week_starts ws
       LEFT JOIN al_by_week al USING (w_offset)
       LEFT JOIN ma_by_week ma USING (w_offset)
       ORDER BY ws.w_offset DESC`,
      [userId, TZ]
    );

    // Compile this_week summary
    const totalStudyMinutes  = alRows.reduce((s, r) => s + (r.minutes || 0), 0);
    const totalManualMinutes = maRows.reduce((s, r) => s + (r.minutes || 0), 0);
    const totalReviews       = alRows.reduce((s, r) => s + (r.review_count || 0), 0);

    // Per-subject totals (merge study + manual)
    const subjectMap = {};
    for (const r of alRows) {
      subjectMap[r.subject] = { subject: r.subject, study_minutes: r.minutes || 0, manual_minutes: 0, review_count: r.review_count || 0 };
    }
    for (const r of maRows) {
      if (r.subject) {
        if (!subjectMap[r.subject]) subjectMap[r.subject] = { subject: r.subject, study_minutes: 0, manual_minutes: 0, review_count: 0 };
        subjectMap[r.subject].manual_minutes += r.minutes || 0;
      }
    }
    const bySubject = Object.values(subjectMap)
      .map(s => ({ ...s, total_minutes: s.study_minutes + s.manual_minutes }))
      .sort((a, b) => b.total_minutes - a.total_minutes);

    // Per manual-type totals
    const manualTypeMap = {};
    for (const r of maRows) {
      manualTypeMap[r.activity_type] = (manualTypeMap[r.activity_type] || 0) + (r.minutes || 0);
    }
    const byManualType = Object.entries(manualTypeMap)
      .map(([activity_type, minutes]) => ({ activity_type, minutes }))
      .sort((a, b) => b.minutes - a.minutes);

    return res.json({
      this_week: {
        week_start:      thisWeekStart,
        study_minutes:   totalStudyMinutes,
        manual_minutes:  totalManualMinutes,
        total_minutes:   totalStudyMinutes + totalManualMinutes,
        active_days:     activeDateRows.length,
        active_dates:    activeDateRows.map(r => r.active_date),
        review_count:    totalReviews,
        by_subject:      bySubject,
        by_manual_type:  byManualType,
      },
      last_8_weeks: trendRows, // already oldest-first (w_offset 7→0 DESC = oldest week first)
    });
  } catch (err) {
    console.error('GET /stats/weekly error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default statsRouter;
