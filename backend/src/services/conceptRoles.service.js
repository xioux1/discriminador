import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';
import { safeJsonParseArray } from './conceptExtractor.service.js';

// ==================== Lazy client ====================

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: Number(process.env.CONCEPT_ROLES_LLM_TIMEOUT_MS || 60_000),
  });
  return _anthropic;
}

// ==================== Vocabulary ====================

export const VALID_ROLES = new Set(['main', 'support', 'example', 'context']);

// Max clusters sent in one LLM call. Over this, batches.
const MAX_CLUSTERS_PER_BATCH = Number(process.env.CONCEPT_ROLES_MAX_CLUSTERS_BATCH || 15);

// ==================== Prompt ====================

export function buildRolePrompt(clusterBatch) {
  const inputJson = JSON.stringify(clusterBatch, null, 2);

  return `Sos un asistente que clasifica conceptos dentro de clusters de estudio según su rol en el cluster.

Para cada concepto, asignale exactamente uno de estos roles:
- "main": concepto central del cluster. Define de qué trata el cluster. Casi siempre hay 1 por cluster, como máximo 2.
- "support": concepto que complementa, extiende o matiza al concepto principal. Puede ser una variante, una propiedad, una limitación o un concepto estrechamente relacionado.
- "example": ejemplo concreto, ilustración, analogía, caso de uso, paso de cálculo o detalle de implementación. Sirve para entender el concepto principal pero no lo define.
- "context": concepto de fondo, prerequisito o marco teórico necesario para entender el cluster, pero que pertenece a un tema más amplio.

Guía por concept_type (sugerencias fuertes; podés ajustar si el contenido lo justifica):
- "core_concept" → "main" o "support"
- "architecture_component" → "main" si es el componente central del cluster, "support" si es periférico
- "method_or_technique" → "main" o "support"
- "sub_concept" → "support"
- "formula" → "support"
- "limitation" → "support"
- "implementation_detail" → "example"
- "example" → "example"
- "calculation_step" → "example"

Reglas:
- Cada cluster debe tener entre 1 y 2 conceptos con role "main". Nunca 0, nunca más de 2.
- Si un cluster tiene solo 2 conceptos, el más central es "main" y el otro "support" o "example".
- No asignes "main" a conceptos con concept_type "example", "calculation_step" o "implementation_detail" salvo que sea el único concepto disponible.
- Respondé SOLO con un JSON array plano con todos los conceptos de todos los clusters.
- Sin texto adicional, sin markdown, sin backticks.

Formato exacto:
[{"concept_id": "uuid", "role": "main|support|example|context"}]

Clusters:
${inputJson}`;
}

// ==================== LLM call ====================

async function callAnthropicRoles(clusterBatch) {
  const model = process.env.CONCEPT_ROLES_MODEL
    || process.env.CONCEPT_CLUSTERING_MODEL
    || 'claude-sonnet-4-20250514';

  const response = await withRetry(
    () => getAnthropicClient().messages.create({
      model,
      max_tokens: 1500,
      temperature: 0.0,
      messages: [{ role: 'user', content: buildRolePrompt(clusterBatch) }],
    }),
    { label: 'callAnthropicRoles' },
  );

  return response.content
    .map(part => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim();
}

// ==================== Persistence ====================

export async function persistRoles(assignments, knownConceptIds) {
  const knownIds = new Set(knownConceptIds);

  const valid = assignments.filter(
    a => a && typeof a.concept_id === 'string'
      && knownIds.has(a.concept_id)
      && VALID_ROLES.has(a.role)
  );

  if (valid.length === 0) return 0;

  const ids   = valid.map(a => a.concept_id);
  const roles = valid.map(a => a.role);

  await dbPool.query(
    `UPDATE concepts
     SET role_in_cluster = u.role
     FROM UNNEST($1::uuid[], $2::text[]) AS u(id, role)
     WHERE concepts.id = u.id`,
    [ids, roles]
  );

  return valid.length;
}

// ==================== Public API ====================

export async function assignRolesForDocument(documentId) {
  logger.info('[conceptRoles] Starting', { documentId });

  const { rows } = await dbPool.query(
    `SELECT c.id          AS concept_id,
            c.label,
            c.definition,
            c.concept_type,
            c.importance,
            cl.id         AS cluster_id,
            cl.name       AS cluster_name,
            cl.definition AS cluster_definition
     FROM concepts c
     JOIN clusters cl ON cl.id = c.cluster_id
     WHERE cl.document_id = $1
     ORDER BY cl.created_at ASC, c.created_at ASC`,
    [documentId]
  );

  if (rows.length === 0) {
    logger.info('[conceptRoles] No clustered concepts', { documentId });
    return { assigned: 0 };
  }

  // Group by cluster
  const clusterMap = new Map();
  for (const row of rows) {
    if (!clusterMap.has(row.cluster_id)) {
      clusterMap.set(row.cluster_id, {
        cluster_id:         row.cluster_id,
        cluster_name:       row.cluster_name,
        cluster_definition: row.cluster_definition,
        concepts:           [],
      });
    }
    clusterMap.get(row.cluster_id).concepts.push({
      id:           row.concept_id,
      label:        row.label,
      definition:   row.definition,
      concept_type: row.concept_type ?? null,
      importance:   row.importance   ?? null,
    });
  }

  const allClusters    = [...clusterMap.values()];
  const allConceptIds  = rows.map(r => r.concept_id);
  const allAssignments = [];

  // Process in batches to stay within LLM context limits
  for (let i = 0; i < allClusters.length; i += MAX_CLUSTERS_PER_BATCH) {
    const batch = allClusters.slice(i, i + MAX_CLUSTERS_PER_BATCH);

    logger.info('[conceptRoles] Batch', {
      documentId,
      batchIndex: Math.floor(i / MAX_CLUSTERS_PER_BATCH),
      clusters: batch.length,
    });

    try {
      const raw    = await callAnthropicRoles(batch);
      const parsed = safeJsonParseArray(raw);
      allAssignments.push(...parsed);
    } catch (err) {
      logger.warn('[conceptRoles] Batch failed, skipping', {
        documentId, batchStart: i, error: err.message,
      });
    }
  }

  const assigned = await persistRoles(allAssignments, allConceptIds);

  logger.info('[conceptRoles] Done', { documentId, assigned });
  return { assigned };
}
