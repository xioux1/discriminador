import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { extractConceptsForDocument, getDocumentConcepts } from '../services/conceptExtractor.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASYNC_WORD_THRESHOLD = 5000;

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

  // Estimate word count from direct text fields; PDF documents always go async
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
