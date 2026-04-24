import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { clusterConceptsForDocument } from '../services/conceptClustering.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/documents/:id/cluster-concepts
router.post('/api/documents/:id/cluster-concepts', async (req, res, next) => {
  const documentId = req.params.id;

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  // Check document exists
  const { rows: docRows } = await dbPool.query(
    'SELECT id FROM documents WHERE id = $1',
    [documentId]
  );
  if (!docRows.length) {
    return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
  }

  // Single query: total concepts + how many are already clustered
  const { rows: countRows } = await dbPool.query(
    `SELECT
       COUNT(*)                                         AS total,
       COUNT(*) FILTER (WHERE cluster_id IS NOT NULL)  AS clustered
     FROM concepts
     WHERE document_id = $1`,
    [documentId]
  );

  const total    = Number(countRows[0].total);
  const clustered = Number(countRows[0].clustered);

  if (total === 0) {
    return res.status(400).json({
      error:   'no_concepts',
      message: 'Document has no concepts to cluster.',
    });
  }

  if (clustered > 0) {
    return res.status(409).json({
      error:   'already_clustered',
      message: 'Document already has clustered concepts.',
    });
  }

  if (total < 3) {
    return res.status(400).json({
      error:   'insufficient_concepts',
      message: 'Document needs at least 3 concepts to cluster.',
    });
  }

  try {
    const result = await clusterConceptsForDocument(documentId);
    return res.json(result);
  } catch (err) {
    logger.error('[clusterConcepts] Pipeline failed', { documentId, error: err.message });
    return next(err);
  }
});

export default router;
