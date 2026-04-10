import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { analyzeSubject } from '../services/advisor.js';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

function weekKey(date) {
  const d = new Date(date);
  const day = d.getDay();
  const mon = new Date(d);
  mon.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  mon.setHours(0, 0, 0, 0);
  return mon.toISOString().slice(0, 10);
}

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
    // 1. Read subject_configs + exam dates + class notes
    const [configResult, examDatesResult, classNotesResult] = await Promise.all([
      dbPool.query('SELECT * FROM subject_configs WHERE subject = $1 AND user_id = $2', [subject, userId]),
      dbPool.query(
        `SELECT * FROM subject_exam_dates
         WHERE subject = $1 AND user_id = $2
         ORDER BY exam_date ASC`,
        [subject, userId]
      ),
      dbPool.query(
        `SELECT title, content FROM subject_class_notes
         WHERE user_id = $1 AND subject = $2
         ORDER BY position ASC, id ASC`,
        [userId, subject]
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
      activityStats,
      classNotes: classNotesResult.rows
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

// POST /advisor/chat
// Body: { subject, message, history: [{role, content}] }
advisorRouter.post('/advisor/chat', async (req, res) => {
  const { subject, message, history = [] } = req.body || {};
  const userId = req.user.id;

  if (!subject?.trim()) return res.status(422).json({ error: 'validation_error', message: 'subject es requerido.' });
  if (!message?.trim()) return res.status(422).json({ error: 'validation_error', message: 'message es requerido.' });
  if (!Array.isArray(history) || history.length > 40) return res.status(422).json({ error: 'validation_error', message: 'history debe ser un array (max 40 items).' });

  try {
    const today = new Date();

    const [configResult, examDatesResult, cardsResult, decisionsResult, sessionsResult, plannerResult, todosResult, timingResult] = await Promise.all([
      dbPool.query(
        `SELECT syllabus_text FROM subject_configs WHERE subject = $1 AND user_id = $2`,
        [subject, userId]
      ),
      dbPool.query(
        `SELECT label, exam_date, exam_type, scope_pct
         FROM subject_exam_dates WHERE subject = $1 AND user_id = $2
         ORDER BY exam_date ASC`,
        [subject, userId]
      ),
      dbPool.query(
        `SELECT pass_count, review_count, interval_days, ease_factor, created_at, last_reviewed_at
         FROM cards
         WHERE subject = $1 AND user_id = $2
           AND archived_at IS NULL AND suspended_at IS NULL`,
        [subject, userId]
      ),
      dbPool.query(
        `SELECT ud.final_grade, ud.decided_at
         FROM user_decisions ud
         JOIN evaluation_items ei ON ud.evaluation_item_id = ei.id
         WHERE COALESCE(NULLIF(trim(ei.input_payload->>'subject'), ''), '(sin materia)') = $1
           AND ud.user_id = $2 AND ud.final_grade IS NOT NULL
         ORDER BY ud.decided_at DESC LIMIT 120`,
        [subject, userId]
      ),
      dbPool.query(
        `SELECT actual_minutes FROM study_sessions
         WHERE user_id = $1 AND actual_minutes IS NOT NULL
         ORDER BY ended_at DESC LIMIT 20`,
        [userId]
      ),
      // Planner slots for current week + next 3 weeks
      dbPool.query(
        `SELECT week_start, day_index, slot_time, content, color
         FROM weekly_planner
         WHERE user_id = $1
           AND week_start >= CURRENT_DATE - INTERVAL '7 days'
           AND week_start <= CURRENT_DATE + INTERVAL '28 days'
         ORDER BY week_start, day_index, slot_time`,
        [userId]
      ),
      // Pending todos
      dbPool.query(
        `SELECT text FROM planner_todos
         WHERE user_id = $1 AND done = false
         ORDER BY position ASC LIMIT 20`,
        [userId]
      ),
      // Avg active and review times (last 60 days)
      dbPool.query(
        `SELECT
           ROUND(AVG(response_time_ms))::int AS avg_active_ms,
           ROUND(AVG(review_time_ms))::int   AS avg_review_ms
         FROM activity_log
         WHERE user_id = $1
           AND logged_date >= CURRENT_DATE - 60`,
        [userId]
      ),
    ]);

    const config     = configResult.rows[0] || null;
    const examDates  = examDatesResult.rows;
    const cards      = cardsResult.rows;

    // ── Planner: aggregate slots by week → day → list of blocks ──────────
    const DAY_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const plannerByWeek = {};
    for (const row of plannerResult.rows) {
      const wk = String(row.week_start).slice(0, 10);
      if (!plannerByWeek[wk]) plannerByWeek[wk] = {};
      const dayKey = DAY_NAMES[row.day_index] || `Día${row.day_index}`;
      if (!plannerByWeek[wk][dayKey]) plannerByWeek[wk][dayKey] = [];
      if (row.content?.trim()) plannerByWeek[wk][dayKey].push(`${row.slot_time} ${row.content.trim()}`);
    }
    // Convert to sorted array of { week, days: {day: [slots]} }
    const plannerSummary = Object.entries(plannerByWeek)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, days]) => ({ week, days }));

    const pendingTodos = todosResult.rows.map(r => r.text);
    const decisions  = decisionsResult.rows;
    const sessions   = sessionsResult.rows;

    // ── Card stats ────────────────────────────────────────────────────────
    const total       = cards.length;
    const mastered    = cards.filter(c => Number(c.interval_days) >= 14).length;
    const neverSeen   = cards.filter(c => Number(c.review_count) === 0).length;
    const struggling  = cards.filter(c => {
      const rr = Number(c.review_count);
      return rr >= 3 && Number(c.pass_count) / rr < 0.5;
    }).length;
    const inProgress  = total - mastered - neverSeen;

    // ── Avg days from card creation to mastery ────────────────────────────
    const masteredWithDates = cards.filter(c =>
      Number(c.interval_days) >= 14 && c.created_at && c.last_reviewed_at
    );
    let avgDaysToMastery = null;
    if (masteredWithDates.length > 0) {
      const sum = masteredWithDates.reduce(
        (s, c) => s + Math.ceil((new Date(c.last_reviewed_at) - new Date(c.created_at)) / 86400000), 0
      );
      avgDaysToMastery = Math.round(sum / masteredWithDates.length);
    }

    // ── New cards added per week (recent 8 weeks) ─────────────────────────
    const byWeek = {};
    for (const c of cards) {
      if (c.created_at) {
        const wk = weekKey(new Date(c.created_at));
        byWeek[wk] = (byWeek[wk] || 0) + 1;
      }
    }
    const recentWeekCounts = Object.entries(byWeek)
      .sort(([a], [b]) => b.localeCompare(a))
      .slice(0, 8)
      .map(([, n]) => n);
    const avgNewCardsPerWeek = recentWeekCounts.length > 0
      ? Math.round(recentWeekCounts.reduce((a, b) => a + b, 0) / recentWeekCounts.length)
      : 0;

    // ── Recent pass rate (last 4 weeks) ───────────────────────────────────
    const cutoff = new Date(today);
    cutoff.setDate(cutoff.getDate() - 28);
    const recent = decisions.filter(d => new Date(d.decided_at) >= cutoff);
    const recentPassRate = recent.length > 0
      ? Number((recent.filter(d => d.final_grade === 'pass').length / recent.length).toFixed(2))
      : null;

    // ── Avg study session length ──────────────────────────────────────────
    const avgSessionMinutes = sessions.length > 0
      ? Math.round(sessions.reduce((s, r) => s + Number(r.actual_minutes), 0) / sessions.length)
      : null;

    // ── Exam schedule ─────────────────────────────────────────────────────
    const examSchedule = examDates.map(e => ({
      label:      e.label,
      exam_date:  e.exam_date,
      exam_type:  e.exam_type,
      scope_pct:  e.scope_pct,
      days_until: Math.ceil((new Date(e.exam_date + 'T00:00:00') - today) / 86400000),
    }));
    const nextExam = examSchedule.find(e => e.days_until >= 0) || null;

    // ── Context object for LLM ────────────────────────────────────────────
    const context = {
      subject,
      today: today.toISOString().slice(0, 10),
      syllabus: config?.syllabus_text?.slice(0, 1500) || null,
      exam_schedule: examSchedule,
      next_exam: nextExam,
      card_stats: {
        total,
        mastered,           // interval_days >= 14 (SM-2 stable)
        in_progress: inProgress,
        never_reviewed: neverSeen,
        struggling,         // pass_rate < 50% after ≥3 reviews
      },
      historical_metrics: {
        avg_days_card_to_mastery:     avgDaysToMastery,
        avg_new_cards_added_per_week: avgNewCardsPerWeek,
        recent_pass_rate_last_4w:     recentPassRate,
        avg_study_session_minutes:    avgSessionMinutes,
        weeks_of_history:             recentWeekCounts.length,
        avg_active_time_ms:  timingResult.rows[0]?.avg_active_ms ? Number(timingResult.rows[0].avg_active_ms) : null,
        avg_review_time_ms:  timingResult.rows[0]?.avg_review_ms ? Number(timingResult.rows[0].avg_review_ms) : null,
      },
      planner_schedule: plannerSummary,
      pending_todos: pendingTodos,
    };

    const systemPrompt = `Sos un tutor universitario experto en planificación de estudio. Tenés acceso al perfil completo del estudiante para "${subject}".

DATOS DEL ESTUDIANTE:
${JSON.stringify(context, null, 2)}

INSTRUCCIONES:
- Estimá el tiempo faltante para dominar los temas usando avg_days_card_to_mastery (días reales historizados) y avg_new_cards_added_per_week (ritmo real), no milisegundos por tarjeta.
- avg_active_time_ms es el tiempo promedio que el estudiante tarda en contestar (fase activa); avg_review_time_ms es el tiempo promedio leyendo la respuesta (fase de revisión). Ambos en milisegundos. Si avg_review_time_ms es significativamente mayor que avg_active_time_ms, el estudiante dedica más tiempo a procesar las respuestas correctas, lo cual es positivo para la retención.
- Si te piden un cronograma, organizalo semana a semana hasta el próximo examen, respetando los bloques ya agendados en planner_schedule y las tareas pendientes en pending_todos.
- Citá los números reales del estudiante cuando sean relevantes (ej: "históricamente tardás X días en dominar una tarjeta").
- Si el planificador tiene slots libres, proponé usarlos para el estudio.
- Sé directo y accionable. Máximo 4 párrafos salvo que pidan cronograma detallado.
- Respondé siempre en español.`;

    const safeHistory = history
      .filter(h => (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
      .map(h => ({ role: h.role, content: h.content.slice(0, 2000) }));

    const response = await getClient().messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      temperature: 0.3,
      system: systemPrompt,
      messages: [...safeHistory, { role: 'user', content: message.trim() }],
    });

    return res.json({ reply: response.content[0]?.text?.trim() || '' });

  } catch (err) {
    const rawMessage = String(err?.message || 'Error desconocido');
    console.error('POST /advisor/chat error', rawMessage);
    return res.status(500).json({ error: 'server_error', message: rawMessage });
  }
});

export default advisorRouter;
