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
    available_concepts: (c.concepts || []).slice(0, 20).map(x => x.label),
  }));

  return `You are a pedagogy expert analyzing topics from a study document to build both a learning sequence AND a rich concept map.

TOPICS:
${JSON.stringify(topics, null, 2)}

YOUR TASK:
Produce two complementary outputs:

1. SEQUENCE — a linear study order (which to study first, prerequisites, etc.)
2. CONCEPT_MAP — a dense, non-linear map showing how topics RELATE, with key concepts as child nodes

Return ONLY valid JSON in this exact shape:
{
  "sequence": [
    {
      "cluster_id": "<id>",
      "learning_order": 1,
      "learning_level": "foundational",
      "requires": []
    }
  ],
  "concept_map": {
    "center_cluster_id": "<id of the single most central/important topic>",
    "blocks": [
      {
        "block_name": "<conceptual role in Spanish, e.g. 'Fundamentos', 'Mecanismo central', 'Arquitectura', 'Comparaciones', 'Aplicaciones'>",
        "cluster_ids": ["<id>", "<id>"]
      }
    ],
    "cluster_concepts": [
      {
        "cluster_id": "<id>",
        "key_concepts": ["<concept label>", "<concept label>", "<concept label>"]
      }
    ],
    "edges": [
      {
        "from_cluster_id": "<id>",
        "to_cluster_id": "<id>",
        "edge_type": "enables",
        "label": "<short Spanish phrase, e.g. 'permite implementar'>"
      }
    ]
  }
}

SEQUENCE RULES:
- learning_order: 1 = study first, higher = study later
- learning_level: "foundational" | "intermediate" | "advanced"
- requires: cluster_ids that must be understood first (only lower learning_order ids)
- No circular dependencies; every topic appears exactly once

CONCEPT MAP RULES:
- center_cluster_id: the ONE topic that is the core of this document
- blocks: group topics by conceptual ROLE, not by study order. Use 2–6 blocks with meaningful Spanish names.
  Each cluster_id appears in exactly one block.
- cluster_concepts: for EACH cluster, select 3–6 key concepts from available_concepts that are
  ESSENTIAL for understanding the topic.
  EXCLUDE: procedural steps, code examples, specific numeric values, implementation minutiae.
  INCLUDE: theoretical constructs, mechanisms, relationships, abstract principles, key terminology.
  Be generous — a rich map is better than a sparse one.
- edges: meaningful relationships between clusters. Be thorough.
  edge_type: "requires" | "produces" | "enables" | "part_of" | "contrasts_with" | "example_of"
  label: 2–5 word Spanish phrase describing the specific link.
  Include 6–14 edges total. Connect clusters across AND within blocks if the relationship is meaningful.
  Prioritize non-obvious, semantically rich relationships over trivial sequential ones.

Return ONLY the JSON object, no explanation.`;
}

// ── LLM call ─────────────────────────────────────────────────────────────────

async function callLLM(clusters) {
  // sequence ~200t/cluster + rich concept_map ~1000t/cluster
  const maxTokens = Math.max(4096, clusters.length * 1000);

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
    if (!parsed?.concept_map) throw new Error('Missing concept_map');
    return parsed;
  } catch {
    logger.warn('[learningGraph] Failed to parse LLM response', { raw: raw.slice(0, 500) });
    return null;
  }
}

// ── Normalisation ─────────────────────────────────────────────────────────────
// Cleans the LLM sequence rather than hard-rejecting it:
//   • strips items with unknown or duplicate cluster_ids
//   • removes requires-references to IDs not yet seen (avoids forward-ref errors)
//   • appends any clusters the LLM omitted, re-using the next learning_order value
// Returns null only when the cleaned sequence ends up completely empty.

function normaliseSequence(sequence, clusterIds) {
  const idSet = new Set(clusterIds);
  const seen  = new Set();
  const clean = [];

  for (const item of sequence) {
    if (!idSet.has(item.cluster_id)) continue;  // unknown id → skip
    if (seen.has(item.cluster_id))   continue;  // duplicate  → skip
    seen.add(item.cluster_id);

    const safeRequires = (item.requires ?? []).filter(r => idSet.has(r) && seen.has(r));
    clean.push({ ...item, requires: safeRequires });
  }

  // Supplement clusters the LLM forgot
  let nextOrder = clean.length ? Math.max(...clean.map(i => i.learning_order ?? 0)) + 1 : 1;
  for (const id of clusterIds) {
    if (!seen.has(id)) {
      clean.push({ cluster_id: id, learning_order: nextOrder++, learning_level: 'advanced', requires: [] });
    }
  }

  return clean.length === 0 ? null : clean;
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function persistLearningGraph(documentId, llmResult) {
  const { sequence, concept_map } = llmResult;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    // Clear existing graph for this document (idempotent re-run)
    await client.query(
      'DELETE FROM cluster_dependencies WHERE document_id = $1',
      [documentId]
    );

    // Reset block/center/concept fields before re-writing
    await client.query(
      `UPDATE clusters SET learning_order = NULL, learning_level = NULL,
         block_name = NULL, is_center = FALSE, key_map_concepts = '[]'::jsonb
       WHERE document_id = $1`,
      [documentId]
    );

    // Write sequence: learning_order, learning_level
    for (const item of sequence) {
      await client.query(
        `UPDATE clusters
         SET learning_order = $1, learning_level = $2
         WHERE id = $3 AND document_id = $4`,
        [item.learning_order, item.learning_level, item.cluster_id, documentId]
      );
    }

    // Write concept_map blocks: block_name
    if (Array.isArray(concept_map?.blocks)) {
      for (const block of concept_map.blocks) {
        for (const cid of (block.cluster_ids ?? [])) {
          await client.query(
            `UPDATE clusters SET block_name = $1 WHERE id = $2 AND document_id = $3`,
            [block.block_name, cid, documentId]
          );
        }
      }
    }

    // Write center cluster
    if (concept_map?.center_cluster_id) {
      await client.query(
        `UPDATE clusters SET is_center = TRUE WHERE id = $1 AND document_id = $2`,
        [concept_map.center_cluster_id, documentId]
      );
    }

    // Write key_map_concepts per cluster
    if (Array.isArray(concept_map?.cluster_concepts)) {
      for (const cc of concept_map.cluster_concepts) {
        const concepts = (cc.key_concepts ?? []).filter(c => typeof c === 'string').slice(0, 6);
        if (!concepts.length) continue;
        await client.query(
          `UPDATE clusters SET key_map_concepts = $1::jsonb WHERE id = $2 AND document_id = $3`,
          [JSON.stringify(concepts), cc.cluster_id, documentId]
        );
      }
    }

    // Insert sequence dependency edges (requires = prerequisite)
    for (const item of sequence) {
      for (const reqId of (item.requires ?? [])) {
        await client.query(
          `INSERT INTO cluster_dependencies (document_id, from_cluster_id, to_cluster_id, edge_semantic_type)
           VALUES ($1, $2, $3, 'requires')
           ON CONFLICT ON CONSTRAINT uq_cluster_dependency DO NOTHING`,
          [documentId, reqId, item.cluster_id]
        );
      }
    }

    // Insert concept_map edges with labels and types
    if (Array.isArray(concept_map?.edges)) {
      for (const edge of concept_map.edges) {
        if (!edge.from_cluster_id || !edge.to_cluster_id) continue;
        if (edge.from_cluster_id === edge.to_cluster_id) continue;
        await client.query(
          `INSERT INTO cluster_dependencies
             (document_id, from_cluster_id, to_cluster_id, edge_label, edge_semantic_type)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT ON CONSTRAINT uq_cluster_dependency DO UPDATE
             SET edge_label = EXCLUDED.edge_label,
                 edge_semantic_type = EXCLUDED.edge_semantic_type`,
          [documentId, edge.from_cluster_id, edge.to_cluster_id,
           edge.label ?? null, edge.edge_type ?? null]
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
 * Builds and persists a pedagogical learning graph + concept map for the document's clusters.
 */
export async function buildLearningGraph(documentId, clusters) {
  if (!clusters || clusters.length < 2) {
    logger.info('[learningGraph] Skipping — fewer than 2 clusters', { documentId });
    return;
  }

  console.log('[learningGraph] building graph', documentId, 'clusters:', clusters.length);
  logger.info('[learningGraph] Building learning graph', {
    documentId,
    clusterCount: clusters.length,
  });

  const llmResult = await callLLM(clusters);

  if (!llmResult) {
    console.warn('[learningGraph] LLM unparseable response', documentId);
    logger.warn('[learningGraph] LLM returned unparseable response, skipping', { documentId });
    return;
  }

  const clusterIds = clusters.map(c => c.id);
  const normalisedSequence = normaliseSequence(llmResult.sequence, clusterIds);
  if (!normalisedSequence) {
    logger.warn('[learningGraph] Sequence normalisation produced empty result, skipping', { documentId });
    return;
  }

  const skipped = clusterIds.length - llmResult.sequence.filter(s => clusterIds.includes(s.cluster_id)).length;
  if (skipped > 0) {
    logger.info('[learningGraph] Supplemented missing clusters in sequence', { documentId, skipped });
  }

  await persistLearningGraph(documentId, { ...llmResult, sequence: normalisedSequence });

  console.log('[learningGraph] graph persisted', documentId);
  logger.info('[learningGraph] Learning graph persisted', {
    documentId,
    sequenceLength: llmResult.sequence.length,
    blockCount: llmResult.concept_map?.blocks?.length ?? 0,
    edgeCount: llmResult.concept_map?.edges?.length ?? 0,
  });
}

/**
 * Returns the learning graph for a document — clusters with sequence, blocks, and typed edges.
 */
export async function getLearningGraph(documentId) {
  const { rows: clusters } = await dbPool.query(
    `SELECT id, name, definition, learning_order, learning_level, block_name, is_center,
            COALESCE(key_map_concepts, '[]'::jsonb) AS key_map_concepts
     FROM clusters
     WHERE document_id = $1 AND learning_order IS NOT NULL
     ORDER BY learning_order ASC`,
    [documentId]
  );

  if (!clusters.length) return null;

  const { rows: deps } = await dbPool.query(
    `SELECT from_cluster_id, to_cluster_id, edge_label, edge_semantic_type
     FROM cluster_dependencies
     WHERE document_id = $1`,
    [documentId]
  );

  const requiresMap = {};
  for (const dep of deps) {
    if (dep.edge_semantic_type === 'requires' || !dep.edge_semantic_type) {
      (requiresMap[dep.to_cluster_id] ??= []).push(dep.from_cluster_id);
    }
  }

  // Group clusters by block_name
  const blockMap = {};
  for (const c of clusters) {
    const key = c.block_name ?? 'Sin clasificar';
    (blockMap[key] ??= []).push(c.id);
  }
  const blocks = Object.entries(blockMap).map(([block_name, cluster_ids]) => ({
    block_name,
    cluster_ids,
  }));

  // Concept map edges (non-requires)
  const edges = deps
    .filter(d => d.edge_semantic_type && d.edge_semantic_type !== 'requires')
    .map(d => ({
      from_cluster_id: d.from_cluster_id,
      to_cluster_id: d.to_cluster_id,
      edge_type: d.edge_semantic_type,
      label: d.edge_label,
    }));

  const center = clusters.find(c => c.is_center);

  return {
    sequence: clusters.map(c => ({
      ...c,
      requires: requiresMap[c.id] ?? [],
    })),
    concept_map: {
      center_cluster_id: center?.id ?? null,
      blocks,
      edges,
    },
  };
}
