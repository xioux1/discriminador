import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { invalidateAdvisorCache } from './advisor.js';

const curriculumRouter = Router();

// GET /exam-calendar — all upcoming exam dates across all subjects
curriculumRouter.get('/exam-calendar', async (req, res) => {
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `SELECT id, subject, label, exam_date, exam_type, scope_pct
       FROM subject_exam_dates
       WHERE user_id = $1
       ORDER BY exam_date ASC`,
      [userId]
    );
    return res.json({ exams: rows });
  } catch (err) {
    console.error('GET /exam-calendar error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

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
  const { syllabus_text, notes_text, daily_new_cards_limit, max_micro_cards_per_card, grading_strictness, micro_cards_enabled, micro_cards_spawn_siblings, auto_variants_enabled, max_variants_per_card } = req.body || {};
  const userId = req.user.id;
  const parsedDailyLimit = daily_new_cards_limit === null || daily_new_cards_limit === undefined || daily_new_cards_limit === ''
    ? null
    : parseInt(daily_new_cards_limit, 10);

  if (parsedDailyLimit !== null && (!Number.isFinite(parsedDailyLimit) || parsedDailyLimit < 0)) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'daily_new_cards_limit debe ser un entero mayor o igual a 0 (o vacío para sin límite).'
    });
  }

  const parsedMicroLimit = max_micro_cards_per_card === null || max_micro_cards_per_card === undefined || max_micro_cards_per_card === ''
    ? null
    : parseInt(max_micro_cards_per_card, 10);

  if (parsedMicroLimit !== null && (!Number.isFinite(parsedMicroLimit) || parsedMicroLimit < 0)) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'max_micro_cards_per_card debe ser un entero mayor o igual a 0 (o vacío para sin límite).'
    });
  }

  const parsedStrictness = grading_strictness === null || grading_strictness === undefined || grading_strictness === ''
    ? 5
    : parseInt(grading_strictness, 10);

  if (!Number.isFinite(parsedStrictness) || parsedStrictness < 0 || parsedStrictness > 10) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'grading_strictness debe ser un entero entre 0 y 10.'
    });
  }

  // micro_cards_enabled defaults to true when not sent
  const parsedMicroEnabled   = micro_cards_enabled   === false || micro_cards_enabled   === 'false' ? false : true;
  const parsedSpawnSiblings  = micro_cards_spawn_siblings === true  || micro_cards_spawn_siblings === 'true'  ? true  : false;
  const parsedAutoVariants   = auto_variants_enabled === true || auto_variants_enabled === 'true' ? true : false;

  const parsedMaxVariants = max_variants_per_card === null || max_variants_per_card === undefined || max_variants_per_card === ''
    ? null
    : parseInt(max_variants_per_card, 10);

  if (parsedMaxVariants !== null && (!Number.isFinite(parsedMaxVariants) || parsedMaxVariants < 1)) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'max_variants_per_card debe ser un entero mayor o igual a 1 (o vacío para sin límite).'
    });
  }

  try {
    const { rows } = await dbPool.query(
      `INSERT INTO subject_configs (subject, syllabus_text, notes_text, daily_new_cards_limit, max_micro_cards_per_card, grading_strictness, micro_cards_enabled, micro_cards_spawn_siblings, auto_variants_enabled, max_variants_per_card, updated_at, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11)
       ON CONFLICT (subject, user_id) DO UPDATE SET
         syllabus_text                = EXCLUDED.syllabus_text,
         notes_text                   = EXCLUDED.notes_text,
         daily_new_cards_limit        = EXCLUDED.daily_new_cards_limit,
         max_micro_cards_per_card     = EXCLUDED.max_micro_cards_per_card,
         grading_strictness           = EXCLUDED.grading_strictness,
         micro_cards_enabled          = EXCLUDED.micro_cards_enabled,
         micro_cards_spawn_siblings   = EXCLUDED.micro_cards_spawn_siblings,
         auto_variants_enabled        = EXCLUDED.auto_variants_enabled,
         max_variants_per_card        = EXCLUDED.max_variants_per_card,
         user_id                      = EXCLUDED.user_id,
         updated_at                   = now()
       RETURNING *`,
      [subject, syllabus_text || null, notes_text || null, parsedDailyLimit, parsedMicroLimit, parsedStrictness, parsedMicroEnabled, parsedSpawnSiblings, parsedAutoVariants, parsedMaxVariants, userId]
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

// ─── Class Notes ─────────────────────────────────────────────────────────────

// GET /curriculum/:subject/class-notes
curriculumRouter.get('/curriculum/:subject/class-notes', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `SELECT id, title, content, position
       FROM subject_class_notes
       WHERE user_id = $1 AND subject = $2
       ORDER BY position ASC, id ASC`,
      [userId, subject]
    );
    return res.json({ class_notes: rows });
  } catch (err) {
    console.error('GET /curriculum/:subject/class-notes error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /curriculum/:subject/class-notes — add a new class entry
curriculumRouter.post('/curriculum/:subject/class-notes', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  const title   = typeof req.body?.title   === 'string' ? req.body.title.trim()   : '';
  const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  try {
    const { rows } = await dbPool.query(
      `INSERT INTO subject_class_notes (user_id, subject, title, content, position)
       VALUES ($1, $2, $3, $4,
         (SELECT COALESCE(MAX(position), 0) + 1 FROM subject_class_notes WHERE user_id = $1 AND subject = $2))
       RETURNING id, title, content, position`,
      [userId, subject, title.slice(0, 200), content.slice(0, 5000)]
    );
    invalidateAdvisorCache(subject, userId);
    return res.status(201).json(rows[0]);
  } catch (err) {
    console.error('POST /curriculum/:subject/class-notes error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PATCH /curriculum/:subject/class-notes/:id — update title or content
curriculumRouter.patch('/curriculum/:subject/class-notes/:id', async (req, res) => {
  const { subject } = req.params;
  const id = Number(req.params.id);
  const userId = req.user.id;
  if (!Number.isFinite(id)) return res.status(422).json({ error: 'validation_error', message: 'invalid id.' });
  const { title, content } = req.body || {};
  try {
    const sets = ['updated_at = now()'];
    const params = [id, userId, subject];
    if (typeof title   === 'string') { params.push(title.trim().slice(0, 200));  sets.push(`title = $${params.length}`); }
    if (typeof content === 'string') { params.push(content.trim().slice(0, 5000)); sets.push(`content = $${params.length}`); }
    const { rows } = await dbPool.query(
      `UPDATE subject_class_notes SET ${sets.join(', ')}
       WHERE id = $1 AND user_id = $2 AND subject = $3
       RETURNING id, title, content, position`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    invalidateAdvisorCache(subject, userId);
    return res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /curriculum/:subject/class-notes/:id error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// DELETE /curriculum/:subject/class-notes/:id
curriculumRouter.delete('/curriculum/:subject/class-notes/:id', async (req, res) => {
  const { subject } = req.params;
  const id = Number(req.params.id);
  const userId = req.user.id;
  if (!Number.isFinite(id)) return res.status(422).json({ error: 'validation_error', message: 'invalid id.' });
  try {
    await dbPool.query(
      'DELETE FROM subject_class_notes WHERE id = $1 AND user_id = $2 AND subject = $3',
      [id, userId, subject]
    );
    invalidateAdvisorCache(subject, userId);
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /curriculum/:subject/class-notes/:id error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default curriculumRouter;
