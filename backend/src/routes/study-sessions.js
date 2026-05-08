import { Router } from 'express';
import { dbPool } from '../db/client.js';
import Anthropic from '@anthropic-ai/sdk';

const studySessionsRouter = Router();

// POST /study/sessions — record session start, return session_id
studySessionsRouter.post('/study/sessions', async (req, res) => {
  const userId = req.user.id;
  const { planned_minutes, planned_card_count, energy_level } = req.body || {};

  if (planned_minutes == null || typeof planned_minutes !== 'number' || planned_minutes < 0) {
    return res.status(422).json({ error: 'validation_error', message: 'planned_minutes es obligatorio.' });
  }

  try {
    const { rows } = await dbPool.query(
      `INSERT INTO study_sessions (user_id, planned_minutes, planned_card_count, energy_level)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [userId, planned_minutes, planned_card_count || 0, energy_level || null]
    );
    return res.status(201).json({ session_id: rows[0].id });
  } catch (err) {
    console.error('POST /study/sessions error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PATCH /study/sessions/:id — record session completion
studySessionsRouter.patch('/study/sessions/:id', async (req, res) => {
  const userId    = req.user.id;
  const sessionId = parseInt(req.params.id, 10);
  const { actual_minutes, actual_card_count } = req.body || {};

  if (!Number.isFinite(sessionId)) {
    return res.status(400).json({ error: 'invalid_id' });
  }

  try {
    await dbPool.query(
      `UPDATE study_sessions
       SET actual_minutes = $1, actual_card_count = $2, ended_at = now()
       WHERE id = $3 AND user_id = $4`,
      [actual_minutes ?? null, actual_card_count ?? 0, sessionId, userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('PATCH /study/sessions/:id error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /study/sessions/calibration — per-user calibration factor from last 10 sessions
studySessionsRouter.get('/study/sessions/calibration', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `SELECT
         COUNT(*)::int AS sessions_used,
         ROUND(AVG(actual_minutes)::numeric, 2) AS avg_actual_minutes,
         ROUND(AVG(planned_minutes)::numeric, 2) AS avg_planned_minutes,
         CASE
           WHEN COUNT(*) >= 3
           THEN GREATEST(0.5, LEAST(2.0,
                  AVG(actual_minutes::numeric / NULLIF(planned_minutes, 0))
                ))::numeric(4,3)
           ELSE 1.0
         END AS calibration_factor
       FROM (
         SELECT actual_minutes, planned_minutes
         FROM study_sessions
         WHERE user_id = $1
           AND actual_minutes IS NOT NULL
           AND planned_minutes > 0
         ORDER BY ended_at DESC
         LIMIT 10
       ) recent`,
      [userId]
    );
    const row = rows[0];
    return res.json({
      calibration_factor:  Number(row.calibration_factor),
      sessions_used:       Number(row.sessions_used),
      avg_actual_minutes:  row.avg_actual_minutes  ? Number(row.avg_actual_minutes)  : null,
      avg_planned_minutes: row.avg_planned_minutes ? Number(row.avg_planned_minutes) : null,
    });
  } catch (err) {
    console.error('GET /study/sessions/calibration error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /study/sessions/analysis — LLM analysis of a session's results for podcast prompt generation.
// Receives all card reviews from the frontend (no DB read needed — data already in memory).
studySessionsRouter.post('/study/sessions/analysis', async (req, res) => {
  const { reviews } = req.body || {};
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return res.status(422).json({ error: 'validation_error', message: 'reviews es obligatorio.' });
  }

  const isPass = (g) => { const s = (g || '').toLowerCase(); return s === 'pass' || s === 'good' || s === 'easy'; };

  const mainReviews = reviews.filter(r => r.type === 'card' && r.grade !== 'uncertain' && r.prompt_text);
  if (mainReviews.length === 0) {
    return res.status(422).json({ error: 'validation_error', message: 'Sin datos de tarjetas para analizar.' });
  }

  const microReviews = reviews.filter(r => r.type === 'micro' && r.grade !== 'uncertain' && r.prompt_text);
  const passed = mainReviews.filter(r => isPass(r.grade));
  const failed = mainReviews.filter(r => !isPass(r.grade));

  const formatCard = (r, idx) => {
    let text = `[${idx + 1}] Tema: ${r.subject || 'sin tema'}\nPregunta: ${r.prompt_text}\nRespuesta esperada: ${r.expected_answer_text}`;
    if (r.user_answer) text += `\nRespuesta del alumno: ${r.user_answer}`;
    if (r.concept_gaps?.length) text += `\nConceptos con fallas detectadas: ${r.concept_gaps.join(', ')}`;
    return text;
  };

  const passedSection = passed.length > 0
    ? `TARJETAS RESPONDIDAS CORRECTAMENTE (${passed.length}):\n\n${passed.map(formatCard).join('\n\n')}`
    : 'No hubo tarjetas respondidas correctamente.';

  const failedSection = failed.length > 0
    ? `TARJETAS FALLADAS (${failed.length}):\n\n${failed.map(formatCard).join('\n\n')}`
    : 'No hubo tarjetas falladas.';

  const microSection = microReviews.length > 0
    ? `\nMICRO-CONCEPTOS EVALUADOS EN SESIÓN:\n${microReviews.map(r => `  [${isPass(r.grade) ? '✓' : '✗'}] ${r.concept || r.prompt_text}: ${r.expected_answer_text}`).join('\n')}`
    : '';

  const cardCount = mainReviews.length;
  const conciseness = cardCount <= 5
    ? 'Podés ser detallado: hay pocas tarjetas.'
    : cardCount <= 12
    ? 'Sé conciso: 2-3 oraciones por brecha o patrón. Priorizá las más importantes.'
    : 'Sé muy conciso: 1-2 oraciones por ítem. Incluí solo las brechas más críticas (máx 5) y los patrones más claros (máx 3).';

  const prompt = `Sos un tutor experto analizando los resultados de una sesión de estudio. Tu tarea es producir un informe concreto que se usará como instrucción para generar un episodio de podcast educativo.

REGLAS:
- ${conciseness}
- Sé específico: en vez de "no entiende X", escribí "entiende la definición de X, pero cuando se le pide aplicarlo a [situación concreta], no logra relacionar [A] con [B]".
- Basate en las respuestas reales del alumno y en los conceptos con fallas detectadas.
- Priorizá lo más urgente.

ESTRUCTURA (en este orden exacto):
1. **PROMPT PARA PODCAST** — primero y obligatorio: un párrafo listo para usar como instrucción a un generador de podcast, describiendo qué temas explicar, a qué profundidad, qué ejemplos incluir y qué errores aclarar.
2. **Lo que el alumno entiende bien** — lista breve de lo que domina.
3. **Brechas principales** — para cada brecha: qué falla exactamente y en qué contexto.
4. **Patrones detectados** — tipo de errores recurrentes.

Idioma: español. Sin generalidades.

---
DATOS DE LA SESIÓN:

${passedSection}

${failedSection}
${microSection}`;

  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
    });

    const analysis = msg.content?.[0]?.text?.trim() || '';
    if (!analysis) return res.status(502).json({ error: 'generation_error', message: 'Empty response from model.' });

    return res.json({ analysis });
  } catch (err) {
    console.error('POST /study/sessions/analysis error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default studySessionsRouter;
