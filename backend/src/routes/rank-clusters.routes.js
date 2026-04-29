import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { rankClustersForDocument } from '../services/clusterRanking.service.js';
import { logger } from '../utils/logger.js';

function isChineseSubject(subject) {
  const s = (subject || '').toLowerCase().trim();
  return s === 'chino' || s === 'chinese' || s === 'mandarín' || s === 'mandarin' || s.includes('chino');
}

// Chinese documents don't use embedding-based density ranking.
// Every word introduced in class is equally high-priority to study.
async function rankClustersForChineseDocument(documentId) {
  const { rows: clusters } = await dbPool.query(
    `SELECT id FROM clusters WHERE document_id = $1 ORDER BY created_at ASC`,
    [documentId]
  );

  const total = clusters.length;
  for (let i = 0; i < total; i++) {
    const cluster = clusters[i];
    // Earlier in the class = slightly higher relative rank, but all are tier A
    const relScore = total > 1 ? 1 - (i / total) * 0.2 : 1.0;
    await dbPool.query(
      `UPDATE clusters SET
         density_score              = 1.0,
         density_coverage_score     = 1.0,
         density_intensity_score    = 1.0,
         importance_score           = 1.0,
         priority_tier              = 'A',
         relative_importance_score  = $1,
         relative_priority_tier     = 'A',
         importance_reasons         = $2,
         importance_computed_at     = NOW()
       WHERE id = $3`,
      [
        relScore,
        JSON.stringify(['Vocabulario introducido en clase']),
        cluster.id,
      ]
    );
  }

  return { document_id: documentId, cluster_count: total };
}

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function getMatchStrength(score) {
  if (score == null) return 'unavailable';
  if (score >= 0.82) return 'strong';
  if (score >= 0.72) return 'moderate';
  return 'weak';
}

// GET /api/documents/:id/rank-clusters — returns already-computed ranking from DB without recomputing
router.get('/api/documents/:id/rank-clusters', async (req, res, next) => {
  const documentId = req.params.id;
  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }
  try {
    const { rows } = await dbPool.query(
      `SELECT
         id, name, definition,
         density_score, density_coverage_score, density_intensity_score,
         program_score, exam_score, importance_score, priority_tier,
         relative_importance_score, relative_priority_tier,
         importance_reasons,
         cards_added_at, cards_added_count, cards_added_subject
       FROM clusters
       WHERE document_id = $1
         AND importance_computed_at IS NOT NULL
       ORDER BY
         CASE relative_priority_tier WHEN 'A' THEN 1 WHEN 'B' THEN 2 WHEN 'C' THEN 3 WHEN 'D' THEN 4 ELSE 5 END,
         importance_score DESC NULLS LAST,
         name ASC`,
      [documentId]
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'No ranking found for this document.' });
    }
    const clusters = rows.map(c => ({
      ...c,
      importance_reasons:   Array.isArray(c.importance_reasons) ? c.importance_reasons : [],
      program_match_strength: getMatchStrength(c.program_score),
      has_program_match:    c.program_score != null && c.program_score >= 0.72,
      exam_match_strength:  getMatchStrength(c.exam_score),
      has_exam_match:       c.exam_score != null && c.exam_score >= 0.72,
    }));
    return res.json({ status: 'stored', document_id: documentId, cluster_count: clusters.length, clusters });
  } catch (err) {
    logger.error('[getRanking] Error', { documentId, error: err.message });
    return next(err);
  }
});

// POST /api/documents/:id/rank-clusters
router.post('/api/documents/:id/rank-clusters', async (req, res, next) => {
  const documentId = req.params.id;

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  const { rows: docRows } = await dbPool.query(
    'SELECT id, subject FROM documents WHERE id = $1',
    [documentId]
  );
  if (!docRows.length) {
    return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
  }

  if (isChineseSubject(docRows[0].subject)) {
    try {
      const result = await rankClustersForChineseDocument(documentId);
      return res.json(result);
    } catch (err) {
      logger.error('[rankClusters] Chinese ranking failed', { documentId, error: err.message });
      return next(err);
    }
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
