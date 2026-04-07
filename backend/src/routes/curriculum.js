import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { invalidateAdvisorCache } from './advisor.js';

const curriculumRouter = Router();

// GET /curriculum/:subject — devuelve { config, exams, exam_dates }
curriculumRouter.get('/curriculum/:subject', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  try {
    const [configResult, examsResult, examDatesResult] = await Promise.all([
      dbPool.query('SELECT * FROM subject_configs WHERE subject = $1 AND user_id = $2', [subject, userId]),
      dbPool.query('SELECT * FROM reference_exams WHERE subject = $1 AND user_id = $2 ORDER BY created_at DESC', [subject, userId]),
      dbPool.query('SELECT * FROM subject_exam_dates WHERE subject = $1 AND user_id = $2 ORDER BY exam_date ASC', [subject, userId])
    ]);
    return res.json({
      config: configResult.rows[0] || null,
      exams: examsResult.rows,
      exam_dates: examDatesResult.rows
    });
  } catch (err) {
    console.error('GET /curriculum/:subject error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PUT /curriculum/:subject — upserta subject_configs (solo syllabus ahora)
curriculumRouter.put('/curriculum/:subject', async (req, res) => {
  const { subject } = req.params;
  const { syllabus_text, notes_text } = req.body;
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `INSERT INTO subject_configs (subject, syllabus_text, notes_text, updated_at, user_id)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (subject) DO UPDATE SET
         syllabus_text = EXCLUDED.syllabus_text,
         notes_text    = EXCLUDED.notes_text,
         user_id       = EXCLUDED.user_id,
         updated_at    = now()
       RETURNING *`,
      [subject, syllabus_text || null, notes_text || null, userId]
    );
    invalidateAdvisorCache(subject, userId);
    return res.json({ config: rows[0] });
  } catch (err) {
    console.error('PUT /curriculum/:subject error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /curriculum/:subject/exam-dates — agrega una fecha de examen
curriculumRouter.post('/curriculum/:subject/exam-dates', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  const { label, exam_date, exam_type, scope_pct } = req.body;

  if (!label || !label.trim()) {
    return res.status(400).json({ error: 'validation_error', message: 'label es obligatorio.' });
  }
  if (!exam_date) {
    return res.status(400).json({ error: 'validation_error', message: 'exam_date es obligatorio.' });
  }
  const pct = parseInt(scope_pct, 10);
  if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
    return res.status(400).json({ error: 'validation_error', message: 'scope_pct debe estar entre 1 y 100.' });
  }

  try {
    const { rows } = await dbPool.query(
      `INSERT INTO subject_exam_dates (subject, user_id, label, exam_date, exam_type, scope_pct)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [subject, userId, label.trim(), exam_date, exam_type || 'parcial', pct]
    );
    const { rows: examDates } = await dbPool.query(
      'SELECT * FROM subject_exam_dates WHERE subject = $1 AND user_id = $2 ORDER BY exam_date ASC',
      [subject, userId]
    );
    invalidateAdvisorCache(subject, userId);
    return res.json({ exam_date: rows[0], exam_dates: examDates });
  } catch (err) {
    console.error('POST /curriculum/:subject/exam-dates error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// DELETE /curriculum/:subject/exam-dates/:id
curriculumRouter.delete('/curriculum/:subject/exam-dates/:id', async (req, res) => {
  const { subject, id } = req.params;
  const userId = req.user.id;
  try {
    await dbPool.query(
      'DELETE FROM subject_exam_dates WHERE id = $1 AND subject = $2 AND user_id = $3',
      [id, subject, userId]
    );
    const { rows: examDates } = await dbPool.query(
      'SELECT * FROM subject_exam_dates WHERE subject = $1 AND user_id = $2 ORDER BY exam_date ASC',
      [subject, userId]
    );
    invalidateAdvisorCache(subject, userId);
    return res.json({ exam_dates: examDates });
  } catch (err) {
    console.error('DELETE /curriculum/:subject/exam-dates/:id error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /curriculum/:subject/exams — agrega un examen de referencia (historial)
curriculumRouter.post('/curriculum/:subject/exams', async (req, res) => {
  const { subject } = req.params;
  const { exam_type, year, label, content_text } = req.body;
  const userId = req.user.id;
  if (!content_text || !content_text.trim()) {
    return res.status(400).json({ error: 'validation_error', message: 'content_text es obligatorio.' });
  }
  try {
    await dbPool.query(
      `INSERT INTO reference_exams (subject, exam_type, year, label, content_text, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [subject, exam_type || 'parcial', year || null, label || null, content_text.trim(), userId]
    );
    const { rows: exams } = await dbPool.query(
      'SELECT * FROM reference_exams WHERE subject = $1 AND user_id = $2 ORDER BY created_at DESC',
      [subject, userId]
    );
    return res.json({ exams });
  } catch (err) {
    console.error('POST /curriculum/:subject/exams error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// DELETE /curriculum/:subject/exams/:id
curriculumRouter.delete('/curriculum/:subject/exams/:id', async (req, res) => {
  const { subject, id } = req.params;
  const userId = req.user.id;
  try {
    await dbPool.query(
      'DELETE FROM reference_exams WHERE id = $1 AND subject = $2 AND user_id = $3',
      [id, subject, userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /curriculum/:subject/exams/:id error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default curriculumRouter;
