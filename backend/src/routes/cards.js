import { Router } from 'express';
import { dbPool } from '../db/client.js';

const cardsRouter = Router();

function normalizeReason(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBatchAction(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

cardsRouter.get('/cards/browser', async (req, res) => {
  const userId = req.user.id;
  const { rows } = await dbPool.query(
    `SELECT
       c.id,
       c.subject,
       c.prompt_text,
       c.expected_answer_text,
       c.next_review_at,
       c.last_reviewed_at,
       c.created_at,
       c.review_count,
       c.pass_count,
       c.interval_days,
       c.ease_factor,
       c.flagged,
       c.notes,
       c.suspended_at,
       COUNT(mc.id) FILTER (WHERE mc.status = 'active')  AS active_micro_count,
       COUNT(cv.id)                                       AS variant_count
     FROM cards c
     LEFT JOIN micro_cards mc ON mc.parent_card_id = c.id AND mc.user_id = c.user_id
     LEFT JOIN card_variants cv ON cv.card_id = c.id
     WHERE c.user_id = $1
       AND c.archived_at IS NULL
     GROUP BY c.id
     ORDER BY c.next_review_at ASC, c.id ASC`,
    [userId]
  );
  return res.json({ cards: rows });
});

// PATCH /cards/:id/flag  — mark a card as flagged with optional note
cardsRouter.patch('/cards/:id/flag', async (req, res) => {
  const userId = req.user.id;
  const cardId = parseInt(req.params.id, 10);
  if (!Number.isFinite(cardId)) return res.status(400).json({ error: 'invalid_id' });

  const notes = typeof req.body.notes === 'string' ? req.body.notes.slice(0, 500) : null;

  const { rowCount } = await dbPool.query(
    `UPDATE cards SET flagged = TRUE, notes = COALESCE($1, notes), updated_at = now()
     WHERE id = $2 AND user_id = $3`,
    [notes, cardId, userId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
  return res.json({ flagged: true });
});

// PATCH /micro-cards/:id/flag  — same for micro-cards
cardsRouter.patch('/micro-cards/:id/flag', async (req, res) => {
  const userId = req.user.id;
  const microId = parseInt(req.params.id, 10);
  if (!Number.isFinite(microId)) return res.status(400).json({ error: 'invalid_id' });

  const notes = typeof req.body.notes === 'string' ? req.body.notes.slice(0, 500) : null;

  const { rowCount } = await dbPool.query(
    `UPDATE micro_cards SET flagged = TRUE, notes = COALESCE($1, notes), updated_at = now()
     WHERE id = $2 AND user_id = $3`,
    [notes, microId, userId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
  return res.json({ flagged: true });
});

// PATCH /cards/:id/archive  — archive card with mandatory reason
cardsRouter.patch('/cards/:id/archive', async (req, res) => {
  const userId = req.user.id;
  const cardId = parseInt(req.params.id, 10);
  if (!Number.isFinite(cardId)) return res.status(400).json({ error: 'invalid_id' });

  const reason = normalizeReason(req.body?.reason);
  if (reason.length < 5) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'reason must contain at least 5 characters.'
    });
  }

  // Check if card exists and belongs to user first
  const { rows: check } = await dbPool.query(
    'SELECT id, archived_at FROM cards WHERE id = $1 AND user_id = $2',
    [cardId, userId]
  );
  if (!check.length) return res.status(404).json({ error: 'not_found', message: 'Tarjeta no encontrada.' });
  if (check[0].archived_at) return res.json({ archived: true }); // already archived — idempotent

  await dbPool.query(
    `UPDATE cards SET archived_at = now(), archived_reason = $1, updated_at = now()
     WHERE id = $2 AND user_id = $3`,
    [reason.slice(0, 500), cardId, userId]
  );
  return res.json({ archived: true });
});

// PATCH /micro-cards/:id/archive  — archive micro-card with mandatory reason
cardsRouter.patch('/micro-cards/:id/archive', async (req, res) => {
  const userId = req.user.id;
  const microId = parseInt(req.params.id, 10);
  if (!Number.isFinite(microId)) return res.status(400).json({ error: 'invalid_id' });

  const reason = normalizeReason(req.body?.reason);
  if (reason.length < 5) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'reason must contain at least 5 characters.'
    });
  }

  const { rows: check } = await dbPool.query(
    'SELECT id, status FROM micro_cards WHERE id = $1 AND user_id = $2',
    [microId, userId]
  );
  if (!check.length) return res.status(404).json({ error: 'not_found', message: 'Micro-tarjeta no encontrada.' });
  if (check[0].status === 'archived') return res.json({ archived: true });

  await dbPool.query(
    `UPDATE micro_cards
     SET status = 'archived',
         notes = CASE
           WHEN notes IS NULL OR trim(notes) = '' THEN $1
           ELSE notes || E'\n[archived] ' || $1
         END,
         updated_at = now()
     WHERE id = $2 AND user_id = $3`,
    [reason.slice(0, 500), microId, userId]
  );

  return res.json({ archived: true });
});

// PATCH /micro-cards/:id/question  — update the question text of a micro-card
cardsRouter.patch('/micro-cards/:id/question', async (req, res) => {
  const userId  = req.user.id;
  const microId = parseInt(req.params.id, 10);
  if (!Number.isFinite(microId)) return res.status(400).json({ error: 'invalid_id' });

  const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
  if (question.length < 5) {
    return res.status(422).json({
      error: 'validation_error',
      message: 'question must contain at least 5 characters.'
    });
  }

  const { rowCount } = await dbPool.query(
    `UPDATE micro_cards SET question = $1, updated_at = now()
     WHERE id = $2 AND user_id = $3 AND status = 'active'`,
    [question, microId, userId]
  );
  if (!rowCount) return res.status(404).json({ error: 'not_found', message: 'Micro-tarjeta no encontrada o archivada.' });

  return res.json({ updated: true });
});

// POST /cards/batch  — bulk actions in browser tab
cardsRouter.post('/cards/batch', async (req, res) => {
  const userId = req.user.id;
  const action = normalizeBatchAction(req.body?.action);
  const idsRaw = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const ids = [...new Set(idsRaw.map((id) => parseInt(id, 10)).filter((id) => Number.isFinite(id)))];
  if (!ids.length) {
    return res.status(422).json({ error: 'validation_error', message: 'ids is required.' });
  }

  if (action === 'archive') {
    const reason = normalizeReason(req.body?.reason);
    if (reason.length < 5) {
      return res.status(422).json({ error: 'validation_error', message: 'reason must contain at least 5 characters.' });
    }
    const { rowCount } = await dbPool.query(
      `UPDATE cards
       SET archived_at = now(),
           archived_reason = $1,
           updated_at = now()
       WHERE user_id = $2
         AND id = ANY($3::int[])
         AND archived_at IS NULL`,
      [reason.slice(0, 500), userId, ids]
    );
    return res.json({ updated: rowCount });
  }

  if (action === 'suspend') {
    const { rowCount } = await dbPool.query(
      `UPDATE cards
       SET suspended_at = now(),
           updated_at = now()
       WHERE user_id = $1
         AND id = ANY($2::int[])
         AND archived_at IS NULL`,
      [userId, ids]
    );
    return res.json({ updated: rowCount });
  }

  if (action === 'reactivate') {
    const { rowCount } = await dbPool.query(
      `UPDATE cards
       SET suspended_at = NULL,
           updated_at = now()
       WHERE user_id = $1
         AND id = ANY($2::int[])
         AND archived_at IS NULL`,
      [userId, ids]
    );
    return res.json({ updated: rowCount });
  }

  if (action === 'edit') {
    const nextSubject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
    const nextPrompt = typeof req.body?.prompt_text === 'string' ? req.body.prompt_text.trim() : '';
    if (!nextSubject && !nextPrompt) {
      return res.status(422).json({
        error: 'validation_error',
        message: 'subject or prompt_text is required for edit.'
      });
    }
    const { rowCount } = await dbPool.query(
      `UPDATE cards
       SET subject = CASE WHEN $1 = '' THEN subject ELSE $1 END,
           prompt_text = CASE WHEN $2 = '' THEN prompt_text ELSE $2 END,
           updated_at = now()
       WHERE user_id = $3
         AND id = ANY($4::int[])
         AND archived_at IS NULL`,
      [nextSubject, nextPrompt, userId, ids]
    );
    return res.json({ updated: rowCount });
  }

  return res.status(422).json({ error: 'validation_error', message: 'Unsupported action.' });
});

// POST /cards/rename-subject — rename all cards of a subject (merge/deduplicate subjects)
cardsRouter.post('/cards/rename-subject', async (req, res) => {
  const userId = req.user.id;
  const { old_subject, new_subject } = req.body || {};

  if (!old_subject || typeof old_subject !== 'string' || !new_subject || typeof new_subject !== 'string') {
    return res.status(422).json({ error: 'validation_error', message: 'old_subject y new_subject son obligatorios.' });
  }

  try {
    const { rowCount } = await dbPool.query(
      `UPDATE cards SET subject = $1, updated_at = now()
       WHERE user_id = $2 AND subject = $3`,
      [new_subject.trim(), userId, old_subject.trim()]
    );
    return res.json({ updated: rowCount });
  } catch (err) {
    console.error('POST /cards/rename-subject error', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default cardsRouter;
