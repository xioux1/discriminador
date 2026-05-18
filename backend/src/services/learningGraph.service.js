import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: Number(process.env.LEARNING_GRAPH_LLM_TIMEOUT_MS || 60_000),
  });
  return _anthropic;
}

const MODEL = process.env.LEARNING_GRAPH_MODEL || 'claude-haiku-4-5-20251001';

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPrompt(clusters) {
  const topics = clusters.map(c => ({
    id: c.id,
    name: c.name,
    definition: c.definition || '',
    key_concepts: (c.concepts || []).slice(0, 6).map(x => x.label),
  }));

  return `You are a pedagogy expert. Given the following learning topics extracted from a study document, determine the optimal learning sequence for a student.

TOPICS:
${JSON.stringify(topics, null, 2)}

YOUR TASK:
Analyze the topics and return a pedagogical ordering — which topic a student should study first, which requires prior knowledge of another, etc.

Return ONLY valid JSON in this exact shape:
{
  "sequence": [
    {
      "cluster_id": "<id from input>",
      "learning_order": 1,
      "learning_level": "foundational",
      "requires": []
    },
    {
      "cluster_id": "<id from input>",
      "learning_order": 2,
      "learning_level": "intermediate",
      "requires": ["<cluster_id that must be mastered first>"]
    }
  ]
}

RULES:
- learning_order: 1 = study first (most foundational), higher number = study later
- learning_level: "foundational" (no prerequisites needed), "intermediate" (builds on foundational), "advanced" (builds on intermediate)
- requires: list of cluster_ids that must be understood before this topic; only reference clusters with lower learning_order
- No circular dependencies
- Every topic in the input must appear exactly once in the output
- Return ONLY the JSON object, no explanation`;
}

// ── LLM call ─────────────────────────────────────────────────────────────────

async function callLLM(clusters) {
  // ~250 tokens per cluster item in the JSON response; add headroom
  const maxTokens = Math.max(2048, clusters.length * 300);

  const response = await withRetry(() =>
    getAnthropicClient().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: buildPrompt(clusters) }],
    })
  );

  const raw = response.content?.[0]?.text?.trim() ?? '';

  // Strip markdown code fences if present
  const jsonText = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed?.sequence)) throw new Error('Missing sequence array');
    return parsed.sequence;
  } catch {
    logger.warn('[learningGraph] Failed to parse LLM response', { raw });
    return null;
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateSequence(sequence, clusterIds) {
  const idSet = new Set(clusterIds);
  const seen = new Set();

  for (const item of sequence) {
    if (!idSet.has(item.cluster_id)) return false;
    if (seen.has(item.cluster_id)) return false;
    seen.add(item.cluster_id);

    const requires = item.requires ?? [];
    for (const reqId of requires) {
      if (!idSet.has(reqId)) return false;
      // Prerequisite must have lower learning_order (already in seen at this point means lower order)
      if (!seen.has(reqId)) return false;
    }
  }

  return seen.size === clusterIds.length;
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function persistLearningGraph(documentId, sequence) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // Clear existing graph for this document (idempotent re-run)
    await client.query(
      'DELETE FROM cluster_dependencies WHERE document_id = $1',
      [documentId]
    );

    // Update learning_order and learning_level on each cluster
    for (const item of sequence) {
      await client.query(
        `UPDATE clusters
         SET learning_order = $1, learning_level = $2
         WHERE id = $3 AND document_id = $4`,
        [item.learning_order, item.learning_level, item.cluster_id, documentId]
      );
    }

    // Insert dependency edges: from_cluster_id must be learned before to_cluster_id
    for (const item of sequence) {
      for (const reqId of (item.requires ?? [])) {
        await client.query(
          `INSERT INTO cluster_dependencies (document_id, from_cluster_id, to_cluster_id)
           VALUES ($1, $2, $3)
           ON CONFLICT ON CONSTRAINT uq_cluster_dependency DO NOTHING`,
          [documentId, reqId, item.cluster_id]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds and persists a pedagogical learning graph for the document's clusters.
 * clusters: array of { id, name, definition, concepts[] } from clusterConceptsForDocument
 */
export async function buildLearningGraph(documentId, clusters) {
  if (!clusters || clusters.length < 2) {
    logger.info('[learningGraph] Skipping — fewer than 2 clusters', { documentId });
    return;
  }

  logger.info('[learningGraph] Building learning graph', {
    documentId,
    clusterCount: clusters.length,
  });

  const sequence = await callLLM(clusters);

  if (!sequence) {
    logger.warn('[learningGraph] LLM returned unparseable response, skipping', { documentId });
    return;
  }

  const clusterIds = clusters.map(c => c.id);
  if (!validateSequence(sequence, clusterIds)) {
    logger.warn('[learningGraph] Sequence validation failed, skipping', {
      documentId,
      sequenceIds: sequence.map(s => s.cluster_id),
      clusterIds,
    });
    return;
  }

  await persistLearningGraph(documentId, sequence);

  logger.info('[learningGraph] Learning graph persisted', {
    documentId,
    sequenceLength: sequence.length,
    edgeCount: sequence.reduce((n, s) => n + (s.requires?.length ?? 0), 0),
  });
}

/**
 * Returns the learning graph for a document — clusters ordered pedagogically
 * with their prerequisite dependencies.
 */
export async function getLearningGraph(documentId) {
  const { rows: clusters } = await dbPool.query(
    `SELECT id, name, definition, learning_order, learning_level
     FROM clusters
     WHERE document_id = $1 AND learning_order IS NOT NULL
     ORDER BY learning_order ASC`,
    [documentId]
  );

  if (!clusters.length) return null;

  const { rows: deps } = await dbPool.query(
    `SELECT from_cluster_id, to_cluster_id
     FROM cluster_dependencies
     WHERE document_id = $1`,
    [documentId]
  );

  // Attach requires[] to each cluster
  const requiresMap = {};
  for (const dep of deps) {
    (requiresMap[dep.to_cluster_id] ??= []).push(dep.from_cluster_id);
  }

  return clusters.map(c => ({
    ...c,
    requires: requiresMap[c.id] ?? [],
  }));
}
