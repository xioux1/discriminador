import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { clusterConceptsForDocument, getClustersForDocument } from '../services/conceptClustering.service.js';
import { clusterConceptsForChineseDocument } from '../services/chineseClassParser.service.js';
import { assignRolesForDocument } from '../services/conceptRoles.service.js';
import { assignRelationsForDocument } from '../services/conceptRelations.service.js';
import { buildLearningGraph } from '../services/learningGraph.service.js';
import { detectDocumentStructure } from '../services/documentStructure.service.js';
import { logger } from '../utils/logger.js';

function isChineseSubject(subject) {
  const s = (subject || '').toLowerCase().trim();
  return s === 'chino' || s === 'chinese' || s === 'mandarín' || s === 'mandarin' || s.includes('chino');
}

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/documents/:id/cluster-concepts
router.post('/api/documents/:id/cluster-concepts', async (req, res, next) => {
  const documentId = req.params.id;

  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  // Check document exists and get subject + structure
  const { rows: docRows } = await dbPool.query(
    'SELECT id, subject, document_structure_json FROM documents WHERE id = $1',
    [documentId]
  );
  if (!docRows.length) {
    return res.status(404).json({ error: 'not_found', message: 'Document not found.' });
  }
  const doc = docRows[0];

  // Chinese subject: deterministic 1:1 clustering, no minimum concept count required
  if (isChineseSubject(doc.subject)) {
    try {
      const result = await clusterConceptsForChineseDocument(documentId);
      return res.json(result);
    } catch (err) {
      logger.error('[clusterConcepts] Chinese pipeline failed', { documentId, error: err.message });
      return next(err);
    }
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

  // Ensure document structure is detected before clustering (non-fatal if it fails)
  let outline = doc.document_structure_json || null;
  if (!outline) {
    outline = await detectDocumentStructure(documentId).catch(err => {
      logger.warn('[clusterConcepts] Structure detection failed (non-fatal)', {
        documentId, error: err.message,
      });
      return null;
    });
  }

  try {
    const result = await clusterConceptsForDocument(documentId, outline);

    // Post-clustering pipeline — runs async, does not block the response.
    setImmediate(() => {
      assignRolesForDocument(documentId)
        .then(() => assignRelationsForDocument(documentId))
        .then(() => buildLearningGraph(documentId, result.clusters))
        .catch(err =>
          logger.warn('[clusterConcepts] Post-clustering pipeline failed (non-fatal)', {
            documentId, error: err.message,
          })
        );
    });

    return res.json(result);
  } catch (err) {
    logger.error('[clusterConcepts] Pipeline failed', { documentId, error: err.message });
    return next(err);
  }
});

// POST /api/documents/:id/build-learning-graph  (trigger for existing clustered docs)
router.post('/api/documents/:id/build-learning-graph', async (req, res, next) => {
  const documentId = req.params.id;
  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }
  try {
    const { rows: clusterRows } = await dbPool.query(
      `SELECT c.id, c.name, c.definition,
              COALESCE(json_agg(json_build_object('label', co.label) ORDER BY co.created_at)
                       FILTER (WHERE co.id IS NOT NULL), '[]') AS concepts
       FROM clusters c
       LEFT JOIN concepts co ON co.cluster_id = c.id AND co.status = 'accepted'
       WHERE c.document_id = $1
       GROUP BY c.id
       ORDER BY c.created_at`,
      [documentId]
    );
    if (!clusterRows.length) {
      console.warn('[build-learning-graph] no clusters for document', documentId);
      return res.status(400).json({ error: 'no_clusters', message: 'Document has no clusters yet.' });
    }
    console.log('[build-learning-graph] starting build for', documentId, 'clusters:', clusterRows.length);
    // Fire and forget — client will poll GET endpoint
    setImmediate(() => {
      buildLearningGraph(documentId, clusterRows).catch(err => {
        console.error('[build-learning-graph] build failed', documentId, err.message);
        logger.warn('[buildLearningGraph] Background build failed', { documentId, error: err.message });
      });
    });
    return res.json({ status: 'building', cluster_count: clusterRows.length });
  } catch (err) {
    return next(err);
  }
});

// GET /api/documents/:id/learning-graph
router.get('/api/documents/:id/learning-graph', async (req, res, next) => {
  const documentId = req.params.id;
  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }
  try {
    const { getLearningGraph } = await import('../services/learningGraph.service.js');
    const graph = await getLearningGraph(documentId);
    if (!graph) {
      return res.status(404).json({ error: 'not_found', message: 'Learning graph not yet built for this document.' });
    }
    return res.json({
      document_id: documentId,
      sequence: graph.sequence,
      concept_map: graph.concept_map,
      concept_map_tree: graph.concept_map_tree ?? null,
    });
  } catch (err) {
    return next(err);
  }
});

// GET /api/documents/:id/clusters
router.get('/api/documents/:id/clusters', async (req, res, next) => {
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
    const result = await getClustersForDocument(documentId);
    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

// GET /api/documents/:id/concept-excerpt?label=...&cluster_id=...
router.get('/api/documents/:id/concept-excerpt', async (req, res, next) => {
  const documentId = req.params.id;
  if (!UUID_RE.test(documentId)) {
    return res.status(400).json({ error: 'invalid_id', message: 'Document ID must be a valid UUID.' });
  }

  const { label, cluster_id } = req.query;
  if (!label) {
    return res.status(400).json({ error: 'missing_label', message: 'label query parameter required.' });
  }

  try {
    let rows = [];

    // Prefer the concept from the specific cluster
    if (cluster_id && UUID_RE.test(cluster_id)) {
      const result = await dbPool.query(
        `SELECT label, definition, source_chunk, evidence
         FROM concepts
         WHERE document_id = $1 AND cluster_id = $2 AND LOWER(label) = LOWER($3)
           AND status = 'accepted'
         ORDER BY created_at ASC LIMIT 1`,
        [documentId, cluster_id, label]
      );
      rows = result.rows;
    }

    // Fallback: any accepted concept in this document with matching label
    if (!rows.length) {
      const result = await dbPool.query(
        `SELECT label, definition, source_chunk, evidence
         FROM concepts
         WHERE document_id = $1 AND LOWER(label) = LOWER($2)
           AND status = 'accepted'
         ORDER BY created_at ASC LIMIT 1`,
        [documentId, label]
      );
      rows = result.rows;
    }

    if (!rows.length) {
      return res.status(404).json({ error: 'not_found', message: 'Concept not found.' });
    }

    const concept = rows[0];
    const excerpt = extractExcerpt(concept.source_chunk, concept.evidence);

    return res.json({
      label:      concept.label,
      definition: concept.definition || null,
      excerpt,
    });
  } catch (err) {
    return next(err);
  }
});

function extractExcerpt(sourceChunk, evidence, wordRadius = 55) {
  if (!sourceChunk) return '';
  const words = sourceChunk.split(/\s+/).filter(Boolean);
  if (words.length <= wordRadius * 2) return words.join(' ');

  let centerWord = 0;
  if (evidence) {
    const evidenceStart = sourceChunk.indexOf(evidence.slice(0, 40));
    if (evidenceStart >= 0) {
      centerWord = sourceChunk.slice(0, evidenceStart).split(/\s+/).filter(Boolean).length;
    }
  }

  const start = Math.max(0, centerWord - wordRadius);
  const end   = Math.min(words.length, centerWord + wordRadius);
  return words.slice(start, end).join(' ');
}

export default router;
