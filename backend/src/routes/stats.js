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
    const passCount = rows.filter((r) => r.final_grade === 'pass').length;
    const failCount = rows.filter((r) => r.final_grade === 'fail').length;

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
      const recent = rows.slice(0, 3).filter((r) => r.final_grade === 'pass').length;
      const older  = rows.slice(3, 6).filter((r) => r.final_grade === 'pass').length;
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
        count: Number(row.cnt)
      });
    }
    const by_subject = Object.entries(bySubjectMap).map(([subject, weeks]) => ({ subject, weeks }));

    // Top 20 slowest cards (by rolling average already maintained on cards table)
    const cardRows = await dbPool.query(
      `SELECT id AS card_id, prompt_text, subject, avg_response_time_ms AS avg_ms
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
      avg_ms: Number(r.avg_ms)
    }));

    return res.json({ by_subject, by_card });
  } catch (err) {
    console.error('GET /stats/timing error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default statsRouter;
