import { Router } from 'express';
import { dbPool } from '../db/client.js';

const router = Router();

function getApiKey() {
  return process.env.COMMITMENT_ENGINE_API_KEY || null;
}

function requireServiceKey(req, res, next) {
  const key = getApiKey();
  if (!key) {
    return res.status(503).json({ error: 'not_configured', message: 'COMMITMENT_ENGINE_API_KEY not set.' });
  }
  const provided = req.headers['x-api-key'];
  if (!provided || provided !== key) {
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid or missing x-api-key header.' });
  }
  next();
}

/**
 * GET /api/commitment-metrics?user_id=X&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Server-to-server endpoint (x-api-key auth) for the commitment engine.
 * Returns aggregated study and activity metrics for a user over a date range.
 */
router.get('/api/commitment-metrics', requireServiceKey, async (req, res) => {
  const { user_id, from, to } = req.query;

  const userId = parseInt(user_id, 10);
  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(422).json({ error: 'validation_error', message: 'user_id must be a positive integer.' });
  }

  const fromDate = new Date(from);
  const toDate   = new Date(to);
  if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
    return res.status(422).json({ error: 'validation_error', message: 'from and to must be valid dates (YYYY-MM-DD).' });
  }
  if (toDate < fromDate) {
    return res.status(422).json({ error: 'validation_error', message: 'to must not be before from.' });
  }

  const fromStr = from.slice(0, 10);
  const toStr   = to.slice(0, 10);

  try {
    // Study minutes and cards reviewed from activity_log
    const { rows: alRows } = await dbPool.query(
      `SELECT
         COALESCE(ROUND(SUM(COALESCE(response_time_ms, 0) + COALESCE(review_time_ms, 0)) / 60000.0)::int, 0) AS study_minutes,
         COUNT(*) FILTER (WHERE activity_type = 'study') AS cards_reviewed,
         COUNT(DISTINCT logged_date) AS study_sessions
       FROM activity_log
       WHERE user_id = $1
         AND logged_date >= $2::date
         AND logged_date <= $3::date`,
      [userId, fromStr, toStr]
    );

    // Oral evaluations from evaluation_items in the period
    const { rows: evalRows } = await dbPool.query(
      `SELECT COUNT(*)::int AS oral_evaluations
       FROM evaluation_items
       WHERE user_id = $1
         AND created_at::date >= $2::date
         AND created_at::date <= $3::date
         AND source_system = 'evaluate_api'`,
      [userId, fromStr, toStr]
    );

    const al = alRows[0] ?? {};

    return res.json({
      period: { from: fromStr, to: toStr },
      metrics: {
        study_minutes:               parseInt(al.study_minutes ?? 0),
        study_sessions:              parseInt(al.study_sessions ?? 0),
        physical_activity_sessions:  0,
        physical_activity_minutes:   0,
        cards_reviewed:              parseInt(al.cards_reviewed ?? 0),
        oral_evaluations:            parseInt(evalRows[0]?.oral_evaluations ?? 0),
      },
    });
  } catch (err) {
    console.error('GET /api/commitment-metrics error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default router;
