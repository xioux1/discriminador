import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { analyzeSubject } from '../services/advisor.js';

const advisorRouter = Router();

// Simple in-memory cache: subject -> { result, timestamp }
const _cache = new Map();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours

export function invalidateAdvisorCache(subject, userId) {
  if (userId) {
    _cache.delete(`${userId}:${subject}`);
  } else {
    // Fallback: clear all entries for the subject
    for (const key of _cache.keys()) {
      if (key.endsWith(`:${subject}`)) _cache.delete(key);
    }
  }
}

// GET /advisor/analysis/:subject
advisorRouter.get('/advisor/analysis/:subject', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  const cacheKey = `${userId}:${subject}`;

  // Check cache
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json(cached.result);
  }

  try {
    // 1. Read subject_configs + all upcoming exam dates for this subject
    const [configResult, examDatesResult] = await Promise.all([
      dbPool.query('SELECT * FROM subject_configs WHERE subject = $1 AND user_id = $2', [subject, userId]),
      dbPool.query(
        `SELECT * FROM subject_exam_dates
         WHERE subject = $1 AND user_id = $2
         ORDER BY exam_date ASC`,
        [subject, userId]
      )
    ]);
    const config = configResult.rows[0] || null;
    // Merge upcoming exam dates into config so analyzeSubject can use them
    if (config) {
      config.exam_dates = examDatesResult.rows;
      // Next upcoming exam (for backward compat fields)
      const next = examDatesResult.rows.find(e => new Date(e.exam_date) >= new Date());
      if (next) {
        config.exam_date  = next.exam_date;
        config.exam_type  = next.exam_type;
        config.exam_label = next.label;
        config.scope_pct  = next.scope_pct;
      }
    }

    if (!config || !config.syllabus_text || !config.syllabus_text.trim()) {
      return res.status(200).json({
        error: 'no_config',
        message: 'Esta materia no tiene plan de estudios configurado.'
      });
    }

    // 2. Read reference_exams
    const { rows: referenceExams } = await dbPool.query(
      'SELECT * FROM reference_exams WHERE subject = $1 AND user_id = $2 ORDER BY created_at DESC',
      [subject, userId]
    );

    // 3. Read cards
    const { rows: cards } = await dbPool.query(
      'SELECT prompt_text, pass_count, review_count FROM cards WHERE subject = $1 AND user_id = $2',
      [subject, userId]
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
         AND ud.user_id = $2
         AND ud.final_grade IS NOT NULL
       ORDER BY ud.decided_at DESC
       LIMIT 50`,
      [subject, userId]
    );

    // 5. Calculate activity stats for last 4 weeks
    const { rows: statsRows } = await dbPool.query(
      `SELECT
         COUNT(*) AS total_reviews,
         COUNT(*) FILTER (WHERE ud.final_grade = 'pass') AS pass_count
       FROM user_decisions ud
       JOIN evaluation_items ei ON ud.evaluation_item_id = ei.id
       WHERE COALESCE(NULLIF(trim(ei.input_payload->>'subject'), ''), '(sin materia)') = $1
         AND ud.user_id = $2
         AND ud.decided_at >= now() - interval '4 weeks'
         AND ud.final_grade IS NOT NULL`,
      [subject, userId]
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
    _cache.set(cacheKey, { result, timestamp: Date.now() });

    return res.json(result);
  } catch (err) {
    const rawMessage = String(err?.message || 'Error desconocido');
    const isCreditsError = /credit balance is too low/i.test(rawMessage);
    const status = Number(err?.status) || Number(err?.statusCode) || (isCreditsError ? 503 : 500);

    if (isCreditsError) {
      console.error('GET /advisor/analysis/:subject provider_credits_exhausted', rawMessage);
      return res.status(503).json({
        error: 'llm_credits_exhausted',
        message: 'El servicio de análisis está temporalmente no disponible por falta de créditos del proveedor LLM. Reintentá en unos minutos.'
      });
    }

    console.error('GET /advisor/analysis/:subject error', rawMessage);
    return res.status(status >= 400 && status < 600 ? status : 500).json({ error: 'server_error', message: rawMessage });
  }
});

export default advisorRouter;
