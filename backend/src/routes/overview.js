import { Router } from 'express';
import { dbPool } from '../db/client.js';

const overviewRouter = Router();

overviewRouter.get('/stats/overview', async (_req, res) => {
  try {
    const { rows } = await dbPool.query(`
      SELECT
        COALESCE(NULLIF(trim(ei.input_payload->>'subject'), ''), '(sin materia)') AS subject,
        trim(ei.input_payload->>'prompt_text')                                    AS prompt_text,
        COUNT(*)                                                                   AS total,
        COUNT(*) FILTER (WHERE ud.final_grade = 'pass')                           AS pass_count,
        COUNT(*) FILTER (WHERE ud.final_grade = 'fail')                           AS fail_count,
        MAX(COALESCE(ud.decided_at, ei.created_at))                               AS last_evaluated_at,
        (array_agg(ud.final_grade ORDER BY COALESCE(ud.decided_at, ei.created_at) DESC))[1] AS last_grade,
        AVG((ei.evaluator_context->'dimensions'->>'core_idea')::numeric)          AS avg_core_idea,
        AVG((ei.evaluator_context->'dimensions'->>'conceptual_accuracy')::numeric) AS avg_conceptual_accuracy,
        AVG((ei.evaluator_context->'dimensions'->>'completeness')::numeric)        AS avg_completeness
      FROM evaluation_items ei
      LEFT JOIN LATERAL (
        SELECT final_grade, decided_at
        FROM user_decisions
        WHERE evaluation_item_id = ei.id
        ORDER BY decided_at DESC
        LIMIT 1
      ) ud ON true
      WHERE ei.source_system = 'evaluate_api'
        AND ud.final_grade IS NOT NULL
      GROUP BY subject, trim(ei.input_payload->>'prompt_text')
      ORDER BY subject ASC, last_evaluated_at DESC
    `);

    // Group by subject
    const bySubject = {};
    for (const row of rows) {
      const subj = row.subject;
      if (!bySubject[subj]) bySubject[subj] = [];

      const dims = {
        core_idea: row.avg_core_idea != null ? Number(Number(row.avg_core_idea).toFixed(2)) : null,
        conceptual_accuracy: row.avg_conceptual_accuracy != null ? Number(Number(row.avg_conceptual_accuracy).toFixed(2)) : null,
        completeness: row.avg_completeness != null ? Number(Number(row.avg_completeness).toFixed(2)) : null,
      };

      const weakest = Object.entries(dims)
        .filter(([, v]) => v != null)
        .sort(([, a], [, b]) => a - b)[0]?.[0] ?? null;

      bySubject[subj].push({
        prompt_text: row.prompt_text,
        total: Number(row.total),
        pass_count: Number(row.pass_count),
        fail_count: Number(row.fail_count),
        pass_rate: Number((row.pass_count / row.total).toFixed(2)),
        last_grade: row.last_grade,
        last_evaluated_at: row.last_evaluated_at,
        weakest_dimension: weakest,
        avg_dimensions: dims
      });
    }

    const subjects = Object.entries(bySubject).map(([subject, questions]) => ({
      subject,
      total_questions: questions.length,
      pass_rate: Number((questions.reduce((s, q) => s + q.pass_count, 0) / questions.reduce((s, q) => s + q.total, 0)).toFixed(2)),
      questions
    })).sort((a, b) => a.subject.localeCompare(b.subject));

    return res.status(200).json({ subjects });
  } catch (error) {
    console.error('Failed to fetch stats overview', { message: error.message });
    return res.status(500).json({ error: 'server_error', message: 'Failed to fetch overview.' });
  }
});

export default overviewRouter;
