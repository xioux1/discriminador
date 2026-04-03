import { Router } from 'express';
import { dbPool } from '../db/client.js';

const statsRouter = Router();

statsRouter.get('/stats/question', async (req, res) => {
  const prompt = typeof req.query.prompt === 'string' ? req.query.prompt.trim() : '';

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
        AND trim(ei.input_payload->>'prompt_text') = $1
        AND ud.final_grade IS NOT NULL
      ORDER BY COALESCE(ud.decided_at, ei.created_at) DESC
      LIMIT 20
    `, [prompt]);

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

    // Recurring errors: correction reasons from corrected decisions
    const recurringErrors = rows
      .filter((r) => r.decision_type === 'corrected' && r.correction_reason)
      .map((r) => r.correction_reason)
      .slice(0, 5);

    const history = rows.slice(0, 10).map((r) => ({
      final_grade: r.final_grade,
      decision_type: r.decision_type,
      correction_reason: r.correction_reason || null,
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
      recurring_errors: recurringErrors,
      history
    });
  } catch (error) {
    console.error('Failed to fetch question stats', { message: error.message });
    return res.status(500).json({ error: 'server_error', message: 'Failed to fetch stats.' });
  }
});

export default statsRouter;
