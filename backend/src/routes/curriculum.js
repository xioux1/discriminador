import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { invalidateAdvisorCache } from './advisor.js';
import { processTranscript } from '../services/transcript-processor.js';
import { extractAndPersistCourseMetadata } from '../services/courseMetadataExtractor.service.js';
import { logger } from '../utils/logger.js';

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
  const { syllabus_text, notes_text, daily_new_cards_limit, max_micro_cards_per_card, grading_strictness, micro_cards_enabled, micro_cards_spawn_siblings, auto_variants_enabled, max_variants_per_card, retention_floor, micro_count_again, micro_count_hard, micro_count_good, micro_count_easy, autoadvance_enabled, autoadvance_question_seconds, autoadvance_answer_seconds, autoadvance_answer_action, learning_steps, new_card_insertion_order, skip_learning_steps } = req.body || {};
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

  const parsedRetentionFloor = retention_floor === null || retention_floor === undefined || retention_floor === ''
    ? 0.75
    : parseFloat(retention_floor);

  if (!Number.isFinite(parsedRetentionFloor) || parsedRetentionFloor < 0.50 || parsedRetentionFloor > 0.99) {
    return res.status(400).json({
      error: 'validation_error',
      message: 'retention_floor debe ser un número entre 50 y 99 (%).'
    });
  }

  function parseMicroCountField(value, defaultValue) {
    if (value === null || value === undefined || value === '') return defaultValue;
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : defaultValue;
  }
  const parsedMicroCountAgain = parseMicroCountField(micro_count_again, 1);
  const parsedMicroCountHard  = parseMicroCountField(micro_count_hard,  1);
  const parsedMicroCountGood  = parseMicroCountField(micro_count_good,  1);
  const parsedMicroCountEasy  = parseMicroCountField(micro_count_easy,  0);

  const parsedAutoadvanceEnabled = autoadvance_enabled === true || autoadvance_enabled === 'true';

  const parseSeconds = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const n = parseFloat(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const parsedAutoadvanceQuestionSeconds = parseSeconds(autoadvance_question_seconds);
  const parsedAutoadvanceAnswerSeconds   = parseSeconds(autoadvance_answer_seconds);

  const validActions = ['again', 'hard', 'good', 'easy'];
  const parsedAutoadvanceAnswerAction = validActions.includes(autoadvance_answer_action)
    ? autoadvance_answer_action
    : 'again';

  const parsedLearningSteps = (typeof learning_steps === 'string' && learning_steps.trim())
    ? learning_steps.trim()
    : '1m 10m';

  const parsedSkipLearningSteps = skip_learning_steps === true || skip_learning_steps === 'true';

  const validInsertionOrders = ['sequential', 'random'];
  const parsedInsertionOrder = validInsertionOrders.includes(new_card_insertion_order)
    ? new_card_insertion_order
    : 'sequential';

  try {
    const { rows } = await dbPool.query(
      `INSERT INTO subject_configs (subject, syllabus_text, notes_text, daily_new_cards_limit, max_micro_cards_per_card, grading_strictness, micro_cards_enabled, micro_cards_spawn_siblings, auto_variants_enabled, max_variants_per_card, retention_floor, micro_count_again, micro_count_hard, micro_count_good, micro_count_easy, autoadvance_enabled, autoadvance_question_seconds, autoadvance_answer_seconds, autoadvance_answer_action, learning_steps, new_card_insertion_order, skip_learning_steps, updated_at, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, now(), $23)
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
         retention_floor              = EXCLUDED.retention_floor,
         micro_count_again            = EXCLUDED.micro_count_again,
         micro_count_hard             = EXCLUDED.micro_count_hard,
         micro_count_good             = EXCLUDED.micro_count_good,
         micro_count_easy             = EXCLUDED.micro_count_easy,
         autoadvance_enabled          = EXCLUDED.autoadvance_enabled,
         autoadvance_question_seconds = EXCLUDED.autoadvance_question_seconds,
         autoadvance_answer_seconds   = EXCLUDED.autoadvance_answer_seconds,
         autoadvance_answer_action    = EXCLUDED.autoadvance_answer_action,
         learning_steps               = EXCLUDED.learning_steps,
         new_card_insertion_order     = EXCLUDED.new_card_insertion_order,
         skip_learning_steps          = EXCLUDED.skip_learning_steps,
         user_id                      = EXCLUDED.user_id,
         updated_at                   = now()
       RETURNING *`,
      [subject, syllabus_text || null, notes_text || null, parsedDailyLimit, parsedMicroLimit, parsedStrictness, parsedMicroEnabled, parsedSpawnSiblings, parsedAutoVariants, parsedMaxVariants, parsedRetentionFloor, parsedMicroCountAgain, parsedMicroCountHard, parsedMicroCountGood, parsedMicroCountEasy, parsedAutoadvanceEnabled, parsedAutoadvanceQuestionSeconds, parsedAutoadvanceAnswerSeconds, parsedAutoadvanceAnswerAction, parsedLearningSteps, parsedInsertionOrder, parsedSkipLearningSteps, userId]
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
      `SELECT id, title, content, position, processing_status,
              (structured_data IS NOT NULL) AS has_structured
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

// ─── Transcript Processing ────────────────────────────────────────────────────

// POST /curriculum/:subject/class-notes/:id/process-transcript
curriculumRouter.post('/curriculum/:subject/class-notes/:id/process-transcript', async (req, res) => {
  const { subject } = req.params;
  const id = Number(req.params.id);
  const userId = req.user.id;
  const { transcript_text } = req.body || {};

  if (!Number.isFinite(id)) return res.status(422).json({ error: 'validation_error', message: 'invalid id.' });
  if (!transcript_text?.trim()) {
    return res.status(422).json({ error: 'validation_error', message: 'transcript_text es obligatorio.' });
  }

  try {
    // Verify note belongs to user
    const { rows } = await dbPool.query(
      'SELECT id FROM subject_class_notes WHERE id = $1 AND user_id = $2 AND subject = $3',
      [id, userId, subject]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    // Fire and forget — stale guard in GET endpoint
    processTranscript({ noteId: id, transcriptText: transcript_text, subject, pool: dbPool, userId })
      .then(() => extractAndPersistCourseMetadata(transcript_text, {
        subject, userId, noteId: id, pool: dbPool,
      }))
      .catch(err => logger.error('[curriculum] transcript pipeline error (non-fatal)',
        { noteId: id, subject, err: err.message }));

    return res.status(202).json({ status: 'processing' });
  } catch (err) {
    console.error('POST /curriculum/:subject/class-notes/:id/process-transcript error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /curriculum/:subject/class-notes/:id/structured
curriculumRouter.get('/curriculum/:subject/class-notes/:id/structured', async (req, res) => {
  const id = Number(req.params.id);
  const userId = req.user.id;
  if (!Number.isFinite(id)) return res.status(422).json({ error: 'validation_error', message: 'invalid id.' });

  try {
    const { rows } = await dbPool.query(
      'SELECT structured_data, processing_status, updated_at FROM subject_class_notes WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    const note = rows[0];
    // Stale guard: if processing for more than 5 minutes, reset to null
    if (note.processing_status === 'processing') {
      const ageMs = Date.now() - new Date(note.updated_at).getTime();
      if (ageMs > 5 * 60 * 1000) {
        await dbPool.query(
          'UPDATE subject_class_notes SET processing_status = NULL, updated_at = now() WHERE id = $1 AND user_id = $2',
          [id, userId]
        );
        note.processing_status = null;
      }
    }

    return res.json({ structured_data: note.structured_data, processing_status: note.processing_status });
  } catch (err) {
    console.error('GET /curriculum/:subject/class-notes/:id/structured', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// ── Lineamientos ───────────────────────────────────────────────────────────────

const VALID_LINEAMIENTO_TYPES = new Set(['trabajo_practico', 'metodologia', 'evaluacion', 'aviso', 'general']);

// GET /curriculum/:subject/lineamientos
curriculumRouter.get('/curriculum/:subject/lineamientos', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  const { type } = req.query;
  try {
    const params = [userId, subject];
    let where = 'WHERE user_id = $1 AND subject = $2';
    if (type && VALID_LINEAMIENTO_TYPES.has(type)) {
      params.push(type);
      where += ` AND lineamiento_type = $${params.length}`;
    }
    const { rows } = await dbPool.query(
      `SELECT id, title, content, lineamiento_type, due_date,
              source_document_id, source_note_id, created_at, updated_at
       FROM subject_lineamientos
       ${where}
       ORDER BY created_at DESC`,
      params
    );
    return res.json({ lineamientos: rows });
  } catch (err) {
    logger.error('GET /curriculum/:subject/lineamientos error', { subject, err: err.message });
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /curriculum/:subject/lineamientos
curriculumRouter.post('/curriculum/:subject/lineamientos', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  const { title, content, lineamiento_type, due_date } = req.body || {};
  if (!title?.trim()) {
    return res.status(422).json({ error: 'validation_error', message: 'title es obligatorio.' });
  }
  const ltype = VALID_LINEAMIENTO_TYPES.has(lineamiento_type) ? lineamiento_type : 'general';
  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(due_date) ? due_date : null;
  try {
    const { rows } = await dbPool.query(
      `INSERT INTO subject_lineamientos (user_id, subject, title, content, lineamiento_type, due_date)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [userId, subject, title.trim(), (content ?? '').trim(), ltype, dueDate]
    );
    return res.status(201).json({ lineamiento: rows[0] });
  } catch (err) {
    logger.error('POST /curriculum/:subject/lineamientos error', { subject, err: err.message });
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// PATCH /curriculum/:subject/lineamientos/:id
curriculumRouter.patch('/curriculum/:subject/lineamientos/:id', async (req, res) => {
  const { subject } = req.params;
  const id = Number(req.params.id);
  const userId = req.user.id;
  if (!Number.isFinite(id)) {
    return res.status(422).json({ error: 'validation_error', message: 'invalid id.' });
  }
  const { title, content, lineamiento_type, due_date } = req.body || {};
  try {
    const sets = ['updated_at = now()'];
    const params = [id, userId, subject];
    if (typeof title === 'string') {
      params.push(title.trim()); sets.push(`title = $${params.length}`);
    }
    if (typeof content === 'string') {
      params.push(content.trim()); sets.push(`content = $${params.length}`);
    }
    if (VALID_LINEAMIENTO_TYPES.has(lineamiento_type)) {
      params.push(lineamiento_type); sets.push(`lineamiento_type = $${params.length}`);
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(due_date)) {
      params.push(due_date); sets.push(`due_date = $${params.length}`);
    } else if (due_date === null) {
      sets.push('due_date = NULL');
    }
    const { rows } = await dbPool.query(
      `UPDATE subject_lineamientos SET ${sets.join(', ')}
       WHERE id = $1 AND user_id = $2 AND subject = $3 RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.json({ lineamiento: rows[0] });
  } catch (err) {
    logger.error('PATCH /curriculum/:subject/lineamientos/:id error', { subject, id, err: err.message });
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// DELETE /curriculum/:subject/lineamientos/:id
curriculumRouter.delete('/curriculum/:subject/lineamientos/:id', async (req, res) => {
  const { subject } = req.params;
  const id = Number(req.params.id);
  const userId = req.user.id;
  if (!Number.isFinite(id)) {
    return res.status(422).json({ error: 'validation_error', message: 'invalid id.' });
  }
  try {
    const { rowCount } = await dbPool.query(
      'DELETE FROM subject_lineamientos WHERE id = $1 AND user_id = $2 AND subject = $3',
      [id, userId, subject]
    );
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    return res.json({ ok: true });
  } catch (err) {
    logger.error('DELETE /curriculum/:subject/lineamientos/:id error', { subject, id, err: err.message });
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /curriculum/:subject/metadata-extractions
curriculumRouter.get('/curriculum/:subject/metadata-extractions', async (req, res) => {
  const { subject } = req.params;
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `SELECT id, source_document_id, source_note_id, extracted_at,
              exam_dates_found, exam_dates_inserted,
              lineamientos_found, lineamientos_inserted, status
       FROM course_metadata_extraction_log
       WHERE user_id = $1 AND subject = $2
       ORDER BY extracted_at DESC
       LIMIT 50`,
      [userId, subject]
    );
    return res.json({ extractions: rows });
  } catch (err) {
    logger.error('GET /curriculum/:subject/metadata-extractions error', { subject, err: err.message });
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default curriculumRouter;
