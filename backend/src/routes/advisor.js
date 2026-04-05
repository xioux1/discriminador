import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { analyzeSubject } from '../services/advisor.js';

const advisorRouter = Router();

// Simple in-memory cache: subject -> { result, timestamp }
const _cache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function invalidateAdvisorCache(subject) {
  _cache.delete(subject);
}

// GET /advisor/analysis/:subject
advisorRouter.get('/advisor/analysis/:subject', async (req, res) => {
  const { subject } = req.params;

  // Check cache
  const cached = _cache.get(subject);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json(cached.result);
  }

  try {
    // 1. Read subject_configs
    const { rows: configRows } = await dbPool.query(
      'SELECT * FROM subject_configs WHERE subject = $1',
      [subject]
    );
    const config = configRows[0] || null;

    if (!config || !config.syllabus_text || !config.syllabus_text.trim()) {
      return res.status(200).json({
        error: 'no_config',
        message: 'Esta materia no tiene plan de estudios configurado.'
      });
    }

    // 2. Read reference_exams
    const { rows: referenceExams } = await dbPool.query(
      'SELECT * FROM reference_exams WHERE subject = $1 ORDER BY created_at DESC',
      [subject]
    );

    // 3. Read cards
    const { rows: cards } = await dbPool.query(
      'SELECT prompt_text, pass_count, review_count FROM cards WHERE subject = $1',
      [subject]
    );

    // 4. Read last 50 user_decisions joined with evaluation_items
    const { rows: decisions } = await dbPool.query(
      `SELECT
         ei.input_payload->>'prompt_text' AS prompt_text,
         ud.final_grade,
         ud.decided_at
       FROM user_decisions ud
       JOIN evaluation_items ei ON ud.evaluation_item_id = ei.id
       WHERE COALESCE(NULLIF(trim(ei.input_payload->>'subject'), ''), '(sin materia)') = $1
         AND ud.final_grade IS NOT NULL
       ORDER BY ud.decided_at DESC
       LIMIT 50`,
      [subject]
    );

    // 5. Calculate activity stats for last 4 weeks
    const { rows: statsRows } = await dbPool.query(
      `SELECT
         COUNT(*) AS total_reviews,
         COUNT(*) FILTER (WHERE ud.final_grade = 'pass') AS pass_count
       FROM user_decisions ud
       JOIN evaluation_items ei ON ud.evaluation_item_id = ei.id
       WHERE COALESCE(NULLIF(trim(ei.input_payload->>'subject'), ''), '(sin materia)') = $1
         AND ud.decided_at >= now() - interval '4 weeks'
         AND ud.final_grade IS NOT NULL`,
      [subject]
    );

    const statsRow = statsRows[0] || {};
    const totalReviews = Number(statsRow.total_reviews || 0);
    const passCount = Number(statsRow.pass_count || 0);
    const activityStats = {
      total_reviews: totalReviews,
      pass_rate: totalReviews > 0 ? Number((passCount / totalReviews).toFixed(2)) : 0,
      streak: null
    };

    // 6. Call analyzeSubject
    const result = await analyzeSubject({
      subject,
      config,
      referenceExams,
      cards,
      decisions,
      activityStats
    });

    // Store in cache
    _cache.set(subject, { result, timestamp: Date.now() });

    return res.json(result);
  } catch (err) {
    console.error('GET /advisor/analysis/:subject error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default advisorRouter;
