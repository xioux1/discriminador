import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { handleUserReply } from '../services/study-nudge.js';

const botChatRouter = Router();

// GET /bot/messages?limit=30
// Returns conversation history for the authenticated user.
botChatRouter.get('/bot/messages', async (req, res) => {
  const userId = req.user.id;
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));

  try {
    const result = await dbPool.query(
      `SELECT id, direction, subject, body, created_at
       FROM bot_conversations
       WHERE user_id = $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [userId, limit]
    );
    return res.json({ messages: result.rows });
  } catch (err) {
    console.error('GET /bot/messages', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /bot/unread-count?since=<ISO timestamp>
// Returns count of outbound messages newer than the given timestamp.
botChatRouter.get('/bot/unread-count', async (req, res) => {
  const userId = req.user.id;
  const since  = req.query.since || new Date(0).toISOString();

  try {
    const result = await dbPool.query(
      `SELECT COUNT(*) AS cnt
       FROM bot_conversations
       WHERE user_id = $1
         AND direction = 'outbound'
         AND created_at > $2::timestamptz`,
      [userId, since]
    );
    return res.json({ unread: parseInt(result.rows[0]?.cnt || 0) });
  } catch (err) {
    console.error('GET /bot/unread-count', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// POST /bot/reply  { text: string }
// User sends a message; bot processes and returns its response.
botChatRouter.post('/bot/reply', async (req, res) => {
  const userId   = req.user.id;
  const replyText = (req.body?.text || '').trim();

  if (!replyText) {
    return res.status(422).json({ error: 'validation_error', message: 'text is required.' });
  }

  try {
    const botReply = await handleUserReply(userId, replyText);
    return res.json({ reply: botReply });
  } catch (err) {
    console.error('POST /bot/reply', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// GET /bot/snoozes
// Returns active subject snoozes for the user.
botChatRouter.get('/bot/snoozes', async (req, res) => {
  const userId = req.user.id;

  try {
    const result = await dbPool.query(
      `SELECT subject, reason, snoozed_until, created_at
       FROM subject_snooze
       WHERE user_id = $1 AND snoozed_until >= CURRENT_DATE
       ORDER BY snoozed_until ASC`,
      [userId]
    );
    return res.json({ snoozes: result.rows });
  } catch (err) {
    console.error('GET /bot/snoozes', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

// DELETE /bot/snoozes/:subject
// Cancels an active snooze so the bot resumes nudging that subject.
botChatRouter.delete('/bot/snoozes/:subject', async (req, res) => {
  const userId  = req.user.id;
  const subject = req.params.subject;

  try {
    await dbPool.query(
      `DELETE FROM subject_snooze WHERE user_id = $1 AND subject = $2`,
      [userId, subject]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error('DELETE /bot/snoozes/:subject', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default botChatRouter;
