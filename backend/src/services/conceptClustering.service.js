import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { safeJsonParseArray } from './conceptExtractor.service.js';

// ==================== Lazy client ====================

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: Number(process.env.CONCEPT_LLM_TIMEOUT_MS || 30_000),
  });
  return _anthropic;
}

// ==================== Geometry ====================

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// clusterA / clusterB are arrays of concept indices into the simMatrix
export function averageClusterSimilarity(clusterA, clusterB, simMatrix) {
  let total = 0;
  for (const i of clusterA) {
    for (const j of clusterB) {
      total += simMatrix[i][j];
    }
  }
  return total / (clusterA.length * clusterB.length);
}

export function preclusterConcepts(concepts, threshold, minClusterSize) {
  const n = concepts.length;

  // Pre-compute full pairwise similarity matrix (indexed by concept position)
  const simMatrix = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    simMatrix[i][i] = 1.0;
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(concepts[i].embedding, concepts[j].embedding);
      simMatrix[i][j] = sim;
      simMatrix[j][i] = sim;
    }
  }

  // Start with singleton clusters (each is an array of concept indices)
  let clusters = concepts.map((_, i) => [i]);

  // Agglomerative average-linkage merging
  while (true) {
    let maxSim = -Infinity;
    let mergeI = -1;
    let mergeJ = -1;

    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const sim = averageClusterSimilarity(clusters[i], clusters[j], simMatrix);
        if (sim > maxSim) {
          maxSim = sim;
          mergeI = i;
          mergeJ = j;
        }
      }
    }

    if (mergeI === -1 || maxSim < threshold) break;

    const merged = [...clusters[mergeI], ...clusters[mergeJ]];
    const next = [];
    for (let k = 0; k < clusters.length; k++) {
      if (k !== mergeI && k !== mergeJ) next.push(clusters[k]);
    }
    next.push(merged);
    clusters = next;
  }

  // Separate groups (size >= minClusterSize) from orphans
  const groups  = [];
  const orphans = [];
  let groupCounter = 1;

  for (const cluster of clusters) {
    if (cluster.length >= minClusterSize) {
      groups.push({
        group_id:    `g${groupCounter++}`,
        concept_ids: cluster.map(i => concepts[i].id),
      });
    } else {
      for (const i of cluster) {
        orphans.push(concepts[i].id);
      }
    }
  }

  return { groups, orphans };
}

// ==================== LLM input / prompt ====================

function buildLLMInput(groups, orphans, conceptMap) {
  return {
    groups: groups.map(g => ({
      group_id: g.group_id,
      concepts: g.concept_ids.map(id => {
        const c = conceptMap.get(id);
        return { id: c.id, label: c.label, definition: c.definition };
      }),
    })),
    orphans: orphans.map(id => {
      const c = conceptMap.get(id);
      return { id: c.id, label: c.label, definition: c.definition };
    }),
  };
}

function buildClusteringPrompt(inputJson) {
  return `Sos un asistente que organiza material de estudio en clusters temáticos.

Se te dan grupos de conceptos pre-agrupados geométricamente y conceptos huérfanos.
Tu tarea:
1. Revisar cada grupo y ajustar si algún concepto no encaja temáticamente.
2. Asignar los conceptos huérfanos al grupo más apropiado, o crear un nuevo grupo si corresponde.
3. Nombrar cada cluster final con un título descriptivo de 3 a 6 palabras.
4. Escribir una definición breve del cluster en una oración.

Input:
${inputJson}

Respondé SOLO con un JSON array. Sin texto adicional, sin markdown, sin backticks.

Formato exacto:
[
  {
    "cluster_name": "nombre descriptivo del cluster",
    "cluster_definition": "oración breve que describe qué agrupa el cluster",
    "concept_ids": ["uuid1", "uuid2"]
  }
]

Reglas:
- Todo concepto debe quedar asignado a algún cluster.
- Ningún concept_id puede aparecer en más de un cluster.
- Mínimo 2 conceptos por cluster.
- No crear clusters de un solo concepto.
- Los concept_ids deben ser exactamente los mismos UUIDs recibidos, sin modificar.
- No inventes concept_ids.
- No modifiques labels ni definitions.
- No agregues conceptos nuevos.
- Si un concepto huérfano no encaja perfectamente, asignalo al cluster más cercano temáticamente.
- Evitá clusters genéricos como "Conceptos generales" salvo que sea estrictamente necesario.`;
}

async function callAnthropicClustering(llmInput) {
  const model     = process.env.CONCEPT_CLUSTERING_MODEL || 'claude-sonnet-4-20250514';
  const inputJson = JSON.stringify(llmInput, null, 2);

  const response = await getAnthropicClient().messages.create({
    model,
    max_tokens:  4096,
    temperature: 0.1,
    messages: [{ role: 'user', content: buildClusteringPrompt(inputJson) }],
  });

  return response.content
    .map(part => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim();
}

// ==================== Validation ====================

export function validateClusteringResult(clusters, allConceptIds) {
  const allIds    = new Set(allConceptIds);
  const seen      = new Set();
  const maxClusters = Math.ceil(allConceptIds.length / 2);

  if (!Array.isArray(clusters) || clusters.length === 0) {
    throw new Error('Validation failed: LLM returned an empty cluster array.');
  }

  if (clusters.length > maxClusters) {
    throw new Error(
      `Validation failed: ${clusters.length} clusters exceeds maximum of ${maxClusters} (ceil(${allConceptIds.length}/2)).`
    );
  }

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];

    if (!cluster.cluster_name || typeof cluster.cluster_name !== 'string' || !cluster.cluster_name.trim()) {
      throw new Error(`Validation failed: cluster[${i}] has an empty cluster_name.`);
    }

    if (!cluster.cluster_definition || typeof cluster.cluster_definition !== 'string' || !cluster.cluster_definition.trim()) {
      throw new Error(`Validation failed: cluster[${i}] ("${cluster.cluster_name}") has an empty cluster_definition.`);
    }

    const nameWords = cluster.cluster_name.trim().split(/\s+/).filter(Boolean);
    if (nameWords.length < 3 || nameWords.length > 8) {
      throw new Error(
        `Validation failed: cluster_name "${cluster.cluster_name}" has ${nameWords.length} word(s) — expected 3-8.`
      );
    }

    if (!Array.isArray(cluster.concept_ids) || cluster.concept_ids.length < 2) {
      throw new Error(
        `Validation failed: cluster "${cluster.cluster_name}" has fewer than 2 concept_ids.`
      );
    }

    for (const id of cluster.concept_ids) {
      if (!allIds.has(id)) {
        throw new Error(
          `Validation failed: concept_id "${id}" in cluster "${cluster.cluster_name}" is not a known concept for this document.`
        );
      }
      if (seen.has(id)) {
        throw new Error(
          `Validation failed: concept_id "${id}" appears in more than one cluster.`
        );
      }
      seen.add(id);
    }
  }

  for (const id of allConceptIds) {
    if (!seen.has(id)) {
      throw new Error(`Validation failed: concept_id "${id}" was not assigned to any cluster.`);
    }
  }
}

// ==================== Persistence ====================

async function persistClusters(documentId, clusters, conceptMap) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    const insertedClusters = [];

    for (const cluster of clusters) {
      const { rows } = await client.query(
        `INSERT INTO clusters (name, definition, document_id, stamp)
         VALUES ($1, $2, $3, NULL)
         RETURNING id, name, definition, stamp`,
        [cluster.cluster_name.trim(), cluster.cluster_definition.trim(), documentId]
      );
      const inserted = rows[0];

      await client.query(
        `UPDATE concepts SET cluster_id = $1 WHERE id = ANY($2::uuid[])`,
        [inserted.id, cluster.concept_ids]
      );

      insertedClusters.push({
        id:         inserted.id,
        name:       inserted.name,
        definition: inserted.definition,
        stamp:      inserted.stamp,
        concepts:   cluster.concept_ids.map(id => {
          const c = conceptMap.get(id);
          return { id: c.id, label: c.label, definition: c.definition };
        }),
      });
    }

    await client.query('COMMIT');
    return insertedClusters;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ==================== Embedding helpers ====================

function parseEmbedding(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/^\[|\]$/g, '').trim();
  if (!cleaned) return null;
  return cleaned.split(',').map(Number);
}

// ==================== Public API ====================

export async function clusterConceptsForDocument(documentId) {
  logger.info('[conceptClustering] Starting', { documentId });

  // Step 1: Fetch concepts with embeddings
  const { rows } = await dbPool.query(
    `SELECT id, label, definition, embedding, cluster_id
     FROM concepts
     WHERE document_id = $1
     ORDER BY created_at ASC`,
    [documentId]
  );

  const concepts = [];
  for (const row of rows) {
    const embedding = parseEmbedding(row.embedding);
    if (!embedding || embedding.length === 0) {
      throw new Error(`Concept "${row.label}" (${row.id}) is missing a valid embedding.`);
    }
    concepts.push({ ...row, embedding });
  }

  logger.info('[conceptClustering] Concepts loaded', { documentId, count: concepts.length });

  // Step 2: Geometric pre-clustering
  const threshold      = Number(process.env.CONCEPT_CLUSTER_SIMILARITY_THRESHOLD || 0.78);
  const minClusterSize = Number(process.env.CONCEPT_CLUSTER_MIN_SIZE || 2);

  const { groups, orphans } = preclusterConcepts(concepts, threshold, minClusterSize);

  logger.info('[conceptClustering] Pre-cluster done', {
    documentId, groups: groups.length, orphans: orphans.length,
  });

  // Step 3: Prepare LLM input
  const conceptMap = new Map(concepts.map(c => [c.id, c]));
  const llmInput   = buildLLMInput(groups, orphans, conceptMap);

  // Step 4: Call LLM
  const rawResponse = await callAnthropicClustering(llmInput);

  logger.info('[conceptClustering] LLM responded', { documentId });

  // Step 5: Tolerant JSON parse
  const parsed = safeJsonParseArray(rawResponse);
  if (!parsed.length) {
    throw new Error('LLM returned invalid or empty JSON for clustering.');
  }

  // Step 6: Strict validation
  const allConceptIds = concepts.map(c => c.id);
  validateClusteringResult(parsed, allConceptIds);

  logger.info('[conceptClustering] Validation passed', {
    documentId, clusterCount: parsed.length,
  });

  // Step 7: Transactional persistence
  const insertedClusters = await persistClusters(documentId, parsed, conceptMap);

  logger.info('[conceptClustering] Done', {
    documentId, clusterCount: insertedClusters.length,
  });

  return {
    status:        'completed',
    document_id:   documentId,
    cluster_count: insertedClusters.length,
    clusters:      insertedClusters,
  };
}
