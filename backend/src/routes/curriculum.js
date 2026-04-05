import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { invalidateAdvisorCache } from './advisor.js';

const curriculumRouter = Router();

// GET /curriculum/:subject — devuelve { config, exams }
curriculumRouter.get('/curriculum/:subject', async (req, res) => {
  const { subject } = req.params;
  try {
    const [configResult, examsResult] = await Promise.all([
      dbPool.query('SELECT * FROM subject_configs WHERE subject = $1', [subject]),
      dbPool.query('SELECT * FROM reference_exams WHERE subject = $1 ORDER BY created_at DESC', [subject])
    ]);
    return res.json({
      config: configResult.rows[0] || null,
      exams: examsResult.rows
    });
  } catch (err) {
    console.error('GET /curriculum/:subject error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PUT /curriculum/:subject — upserta subject_configs
curriculumRouter.put('/curriculum/:subject', async (req, res) => {
  const { subject } = req.params;
  const { syllabus_text, exam_date, exam_type } = req.body;
  try {
    const { rows } = await dbPool.query(
      `INSERT INTO subject_configs (subject, syllabus_text, exam_date, exam_type, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (subject) DO UPDATE SET
         syllabus_text = EXCLUDED.syllabus_text,
         exam_date     = EXCLUDED.exam_date,
         exam_type     = EXCLUDED.exam_type,
         updated_at    = now()
       RETURNING *`,
      [subject, syllabus_text || null, exam_date || null, exam_type || 'parcial']
    );
    invalidateAdvisorCache(subject);
    return res.json({ config: rows[0] });
  } catch (err) {
    console.error('PUT /curriculum/:subject error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /curriculum/:subject/exams — agrega un examen de referencia
curriculumRouter.post('/curriculum/:subject/exams', async (req, res) => {
  const { subject } = req.params;
  const { exam_type, year, label, content_text } = req.body;
  if (!content_text || !content_text.trim()) {
    return res.status(400).json({ error: 'validation_error', message: 'content_text es obligatorio.' });
  }
  try {
    await dbPool.query(
      `INSERT INTO reference_exams (subject, exam_type, year, label, content_text)
       VALUES ($1, $2, $3, $4, $5)`,
      [subject, exam_type || 'parcial', year || null, label || null, content_text.trim()]
    );
    const { rows: exams } = await dbPool.query(
      'SELECT * FROM reference_exams WHERE subject = $1 ORDER BY created_at DESC',
      [subject]
    );
    return res.json({ exams });
  } catch (err) {
    console.error('POST /curriculum/:subject/exams error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// DELETE /curriculum/:subject/exams/:id — borra un examen de referencia
curriculumRouter.delete('/curriculum/:subject/exams/:id', async (req, res) => {
  const { subject, id } = req.params;
  try {
    await dbPool.query(
      'DELETE FROM reference_exams WHERE id = $1 AND subject = $2',
      [id, subject]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /curriculum/:subject/exams/:id error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default curriculumRouter;
