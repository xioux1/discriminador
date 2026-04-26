import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { extractConceptsForDocument, getDocumentConcepts } from '../services/conceptExtractor.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASYNC_WORD_THRESHOLD = 5000;

// ── Document CRUD ──────────────────────────────────────────────────────────────

// GET /api/documents — list documents for the authenticated user
router.get('/api/documents', async (req, res, next) => {
  const userId = req.user.id;
  try {
    const { rows } = await dbPool.query(
      `SELECT
         d.id,
         d.original_filename,
         d.subject,
         d.status,
         d.created_at,
         COALESCE(
           array_length(
             regexp_split_to_array(
               trim(COALESCE(d.text, d.content, d.transcript, '')),
               '\\s+'
             ), 1
           ), 0
         ) AS word_count,
         COUNT(DISTINCT c.id)::int AS concept_count,
         COUNT(DISTINCT cl.id)::int AS cluster_count
       FROM documents d
       LEFT JOIN concepts c  ON c.document_id = d.id
       LEFT JOIN clusters cl ON cl.document_id = d.id
       WHERE d.user_id = $1
       GROUP BY d.id
       ORDER BY d.created_at DESC`,
      [userId]
    );
    return res.json({ documents: rows });
  } catch (err) {
    return next(err);
  }
});

// POST /api/documents — create a document from pasted text
router.post('/api/documents', async (req, res, next) => {
  const userId = req.user.id;
  const { text, original_filename, subject } = req.body || {};

  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'bad_request', message: 'text is required.' });
  }

  const subjectVal = subject ? String(subject).trim() : null;

  try {
    const { rows } = await dbPool.query(
      `INSERT INTO documents (user_id, text, original_filename, subject)
       VALUES ($1, $2, $3, $4)
       RETURNING id, original_filename, subject, status, created_at`,
      [userId, String(text).trim(), original_filename ? String(original_filename).trim() : null, subjectVal]
    );
    const doc = rows[0];
    return res.status(201).json({
      document: { ...doc, word_count: String(text).trim().split(/\s+/).filter(Boolean).length, concept_count: 0, cluster_count: 0 }
    });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/documents/:id/subject — update the subject linked to a document
router.patch('/api/documents/:id/subject', async (req, res, next) => {
  const userId = req.user.id;
  const documentId = req.params.id;

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  const subjectVal = req.body?.subject ? String(req.body.subject).trim() : null;

  try {
    const { rows } = await dbPool.query(
      `UPDATE documents SET subject = $1, updated_at = NOW()
       WHERE id = $2 AND user_id = $3
       RETURNING id, subject`,
      [subjectVal, documentId, userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
    }
    return res.json({ subject: rows[0].subject });
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/documents/:id — delete a document (and cascade its concepts)
router.delete('/api/documents/:id', async (req, res, next) => {
  const userId = req.user.id;
  const documentId = req.params.id;

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  try {
    const { rows } = await dbPool.query(
      'DELETE FROM documents WHERE id = $1 AND user_id = $2 RETURNING id',
      [documentId, userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
    }
    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

// ── Concept extraction ─────────────────────────────────────────────────────────

// POST /api/documents/:id/extract-concepts
router.post('/api/documents/:id/extract-concepts', async (req, res, next) => {
  const documentId = req.params.id;

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  const { rows } = await dbPool.query('SELECT * FROM documents WHERE id = $1', [documentId]);
  if (!rows.length) {
    return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
  }

  const document = rows[0];

  const directText = document.text || document.content || document.transcript || '';
  const wordCount = directText.split(/\s+/).filter(Boolean).length;
  const isPdfOnly = !directText && Boolean(document.file_path);
  const goAsync = isPdfOnly || wordCount > ASYNC_WORD_THRESHOLD;

  if (goAsync) {
    setImmediate(async () => {
      try {
        await extractConceptsForDocument(documentId);
      } catch (err) {
        logger.error('[conceptExtractor] Async extraction failed', {
          documentId, error: err.message,
        });
      }
    });

    return res.status(202).json({
      status: 'queued',
      document_id: documentId,
      message: 'Concept extraction started.',
    });
  }

  try {
    const concepts = await extractConceptsForDocument(documentId);
    return res.status(200).json({
      status: 'completed',
      document_id: documentId,
      concept_count: concepts.length,
      concepts,
    });
  } catch (err) {
    if (err.message.includes('enough text')) {
      return res.status(422).json({ error: 'insufficient_text', message: err.message });
    }
    return next(err);
  }
});

// GET /api/documents/:id/content — return document text and basic metadata
router.get('/api/documents/:id/content', async (req, res, next) => {
  const userId = req.user.id;
  const documentId = req.params.id;

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  try {
    const { rows } = await dbPool.query(
      `SELECT id, original_filename, subject, status, created_at,
              COALESCE(text, content, transcript) AS document_text
       FROM documents
       WHERE id = $1 AND user_id = $2`,
      [documentId, userId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
    }
    const doc = rows[0];
    const text = doc.document_text || '';
    return res.json({
      id: doc.id,
      original_filename: doc.original_filename,
      subject: doc.subject,
      status: doc.status,
      created_at: doc.created_at,
      text,
      word_count: text ? text.split(/\s+/).filter(Boolean).length : 0,
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/documents/:id/concepts
router.get('/api/documents/:id/concepts', async (req, res, next) => {
  const documentId = req.params.id;

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  const { rows: docRows } = await dbPool.query(
    'SELECT id FROM documents WHERE id = $1',
    [documentId]
  );
  if (!docRows.length) {
    return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
  }

  try {
    const concepts = await getDocumentConcepts(documentId);
    return res.json({
      document_id: documentId,
      concept_count: concepts.length,
      concepts,
    });
  } catch (err) {
    return next(err);
  }
});

export default router;
