import { Router } from 'express';
import { dbPool } from '../db/client.js';

const cardsRouter = Router();

function normalizeReason(value) {
  return typeof value === 'string' ? value.trim() : '';
}

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

  const { rowCount } = await dbPool.query(
    `UPDATE cards
     SET archived_at = now(),
         archived_reason = $1,
         updated_at = now()
     WHERE id = $2 AND user_id = $3 AND archived_at IS NULL`,
    [reason.slice(0, 500), cardId, userId]
  );
  if (rowCount === 0) return res.status(404).json({ error: 'not_found' });
  return res.json({ archived: true });
});

export default cardsRouter;
