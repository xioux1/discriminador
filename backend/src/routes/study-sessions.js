import { Router } from 'express';
import { dbPool } from '../db/client.js';
import Anthropic from '@anthropic-ai/sdk';

const studySessionsRouter = Router();

// POST /study/sessions — record session start, return session_id
studySessionsRouter.post('/study/sessions', async (req, res) => {
  const userId = req.user.id;
  const { planned_minutes, planned_card_count, energy_level, subject_name } = req.body || {};

  if (planned_minutes == null || typeof planned_minutes !== 'number' || planned_minutes < 0) {
    return res.status(422).json({ error: 'validation_error', message: 'planned_minutes es obligatorio.' });
  }

  try {
    const { rows } = await dbPool.query(
      `INSERT INTO study_sessions (user_id, planned_minutes, planned_card_count, energy_level, subject_name)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, planned_minutes, planned_card_count || 0, energy_level || null, subject_name || null]
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

// PATCH /study/sessions/:id/end-time — correct ended_at for a session that was left open
studySessionsRouter.patch('/study/sessions/:id/end-time', async (req, res) => {
  const userId    = req.user.id;
  const sessionId = parseInt(req.params.id, 10);
  const { ended_at } = req.body || {};

  if (!Number.isFinite(sessionId)) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  if (!ended_at) {
    return res.status(422).json({ error: 'validation_error', message: 'ended_at es obligatorio.' });
  }

  const endDate = new Date(ended_at);
  if (isNaN(endDate.getTime())) {
    return res.status(422).json({ error: 'validation_error', message: 'ended_at no es una fecha válida.' });
  }
  if (endDate > new Date()) {
    return res.status(422).json({ error: 'validation_error', message: 'ended_at no puede ser en el futuro.' });
  }

  try {
    const { rows } = await dbPool.query(
      `SELECT started_at FROM study_sessions WHERE id = $1 AND user_id = $2`,
      [sessionId, userId]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'not_found', message: 'Sesión no encontrada.' });
    }
    const startDate = new Date(rows[0].started_at);
    if (endDate <= startDate) {
      return res.status(422).json({ error: 'validation_error', message: 'ended_at debe ser posterior al inicio de la sesión.' });
    }

    const actualMinutes = (endDate - startDate) / 60000;

    await dbPool.query(
      `UPDATE study_sessions
       SET ended_at = $1, actual_minutes = $2
       WHERE id = $3 AND user_id = $4`,
      [endDate.toISOString(), actualMinutes, sessionId, userId]
    );
    return res.json({ ok: true, actual_minutes: actualMinutes });
  } catch (err) {
    console.error('PATCH /study/sessions/:id/end-time error', err.message);
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

// POST /study/sessions/analysis — study guide generated from session results.
// Receives all card reviews from the frontend (no DB read needed — data already in memory).
studySessionsRouter.post('/study/sessions/analysis', async (req, res) => {
  const userId = req.user.id;
  const { reviews, session_id } = req.body || {};
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return res.status(422).json({ error: 'validation_error', message: 'reviews es obligatorio.' });
  }

  const isPass = (g) => { const s = (g || '').toLowerCase(); return s === 'pass' || s === 'good' || s === 'easy'; };

  const mainReviews = reviews.filter(r => r.type === 'card' && r.grade !== 'uncertain' && r.prompt_text);
  if (mainReviews.length === 0) {
    return res.status(422).json({ error: 'validation_error', message: 'Sin datos de tarjetas para analizar.' });
  }

  const microReviews = reviews.filter(r => r.type === 'micro' && r.grade !== 'uncertain' && r.prompt_text);

  // Only include items the user got wrong — the analysis is a remedial study note
  const failedCards = mainReviews.filter(r => !isPass(r.grade));
  const failedMicro = microReviews.filter(r => !isPass(r.grade));

  if (failedCards.length === 0 && failedMicro.length === 0) {
    return res.json({ analysis: 'No hubo respuestas incorrectas en esta sesión. ¡Excelente desempeño!' });
  }

  const formatCard = (r) => {
    let text = `Pregunta/Ejercicio: ${r.prompt_text}\nRespuesta correcta: ${r.expected_answer_text}`;
    if (r.user_answer) text += `\nRespuesta dada: ${r.user_answer}`;
    if (r.concept_gaps?.length) text += `\nConceptos declarados: ${r.concept_gaps.join(', ')}`;
    return text;
  };

  const cardsSection = failedCards.map(formatCard).join('\n\n---\n\n');

  const microSection = failedMicro.length > 0
    ? `\nMICRO-CONCEPTOS A REPASAR:\n${failedMicro.map(r => `- ${r.concept || r.prompt_text}`).join('\n')}`
    : '';

  const prompt = `Sos un tutor experto. A partir de los ejercicios y preguntas que el alumno no respondió correctamente, vas a generar un apunte de estudio enfocado en el concepto puntual que falló, no en el tema general del ejercicio.

PROCESO PARA CADA ÍTEM:
1. Analizá la "Respuesta dada" versus la "Respuesta correcta". Identificá el paso, operación, razonamiento o concepto específico donde ocurrió la falla. Esto puede ser distinto al tema general del ejercicio. Por ejemplo: si el ejercicio es de MRUV pero la falla estuvo en despejar una variable de una ecuación cuadrática, el apunte debe ser sobre ese despeje, no sobre MRUV.
2. Determiná el concepto mínimo que el alumno necesita dominar para no volver a fallar en ese punto específico. Ese concepto es el tema central del apunte, no el ejercicio completo.
3. Escribí el apunte centrado en ese concepto puntual: presentalo, explicalo en profundidad, usá ejemplos concretos que lo ilustren.

REGLAS DE ESCRITURA:
- Escribí como si fuera un apunte de clase sobre ese concepto específico. No hagas referencia al ejercicio original ni al contexto donde surgió.
- Nunca menciones el error, el alumno, ni uses frases como "te equivocaste en", "error frecuente", "error común", "el alumno falló", "la respuesta fue incorrecta".
- El apunte debe poder leerse de forma autónoma: alguien que lo lea sin haber visto el ejercicio debe entender perfectamente el concepto.
- No amplíes a temas no relacionados con el concepto puntual identificado.
- Idioma: español.

---
ÍTEMS A ANALIZAR:

${cardsSection}
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

    if (session_id) {
      await dbPool.query(
        `UPDATE study_sessions SET analysis = $1 WHERE id = $2 AND user_id = $3`,
        [analysis, session_id, userId]
      ).catch(() => {}); // non-fatal
    }

    return res.json({ analysis });
  } catch (err) {
    console.error('POST /study/sessions/analysis error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /study/sessions/history — last 30 sessions that have a saved analysis
studySessionsRouter.get('/study/sessions/history', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `SELECT id, started_at, ended_at, actual_minutes, actual_card_count, analysis
       FROM study_sessions
       WHERE user_id = $1
       ORDER BY started_at DESC
       LIMIT 30`,
      [userId]
    );
    return res.json({ sessions: rows });
  } catch (err) {
    console.error('GET /study/sessions/history error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default studySessionsRouter;
