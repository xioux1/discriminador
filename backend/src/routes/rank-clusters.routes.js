import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { rankClustersForDocument } from '../services/clusterRanking.service.js';
import { logger } from '../utils/logger.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/documents/:id/rank-clusters
router.post('/api/documents/:id/rank-clusters', async (req, res, next) => {
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
    const result = await rankClustersForDocument(documentId);
    return res.json(result);
  } catch (err) {
    if (err.statusCode) {
      const status = err.statusCode;
      const errorCode = status === 404 ? 'not_found' : 'validation_error';
      return res.status(status).json({ error: errorCode, message: err.message });
    }
    logger.error('[rankClusters] Pipeline failed', { documentId, error: err.message });
    return next(err);
  }
});

export default router;
