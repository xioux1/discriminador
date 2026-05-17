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
    timeout: Number(process.env.CONCEPT_RELATIONS_LLM_TIMEOUT_MS || 60_000),
  });
  return _anthropic;
}

// ==================== Vocabulary ====================

export const VALID_RELATION_TYPES = new Set([
  'example_of', 'part_of', 'depends_on', 'contrasts_with', 'formula_for', 'motivates',
]);

const MIN_CONFIDENCE           = 0.5;
const MIN_RATIONALE_WORDS      = 8;
const MAX_CLUSTERS_PER_BATCH   = Number(process.env.CONCEPT_RELATIONS_MAX_CLUSTERS_BATCH || 10);

// Roles/types that are low-signal as both endpoints of a relation
const LOW_SIGNAL_ROLES  = new Set(['example', 'context']);
const LOW_SIGNAL_TYPES  = new Set(['calculation_step', 'implementation_detail', 'example']);
// Relation types that are still meaningful between low-signal endpoints
const ALLOWED_LOW_SIGNAL = new Set(['part_of', 'formula_for']);

// ==================== Prompt ====================

export function buildRelationsPrompt(clusterBatch) {
  const inputJson = JSON.stringify(clusterBatch, null, 2);

  return `Sos un asistente que detecta relaciones semánticas entre conceptos dentro de clusters de estudio.

Para cada par de conceptos relacionados dentro del mismo cluster, identificá la relación más importante.

Tipos de relación permitidos:
- "example_of": source es un ejemplo concreto de target.
- "part_of": source es componente, subparte o etapa de target.
- "depends_on": source requiere conceptualmente target para entenderse.
- "contrasts_with": source se entiende por diferencia/oposición con target.
- "formula_for": source es fórmula, ecuación o expresión formal usada para target.
- "motivates": source es problema, limitación o necesidad que justifica target.

Dirección canónica:
- "example_of": source = el ejemplo concreto, target = el concepto general.
- "part_of": source = la parte o etapa, target = el todo.
- "depends_on": source = el concepto que depende, target = el requisito conceptual.
- "formula_for": source = la fórmula/expresión, target = el concepto calculado o explicado.
- "motivates": source = el problema o limitación, target = la solución o concepto motivado.
- "contrasts_with": cualquiera puede ser source, pero guardá una sola dirección.

Reglas obligatorias:
- Solo relaciones entre conceptos del mismo cluster. Nunca cross-cluster.
- Máximo 8 relaciones por cluster. Priorizá las más informativas.
- confidence entre 0.0 y 1.0. Incluí solo relaciones con confidence >= 0.5.
- rationale obligatorio: mínimo 8 palabras, específico para esta relación concreta. No uses frases genéricas como "están relacionados" o "ambos pertenecen al mismo tema".
- Evitá relaciones donde ambos extremos tengan role_in_cluster "example" o "context", o concept_type "calculation_step" o "implementation_detail", salvo que relation_type sea "part_of" o "formula_for" y el rationale justifique la relación concretamente.
- No crees relaciones simétricas duplicadas. Si A contrasts_with B, no incluyas B contrasts_with A.
- Si un cluster tiene menos de 2 conceptos, no emitas relaciones para él.
- Si no hay relaciones claras en un cluster, no emitas entradas para ese cluster.
- Respondé SOLO con un JSON array plano. Sin texto adicional, sin markdown, sin backticks.

Formato exacto:
[{"source_concept_id": "uuid", "target_concept_id": "uuid", "relation_type": "...", "confidence": 0.85, "rationale": "explicación específica de por qué esta relación existe"}]

Clusters con conceptos y sus roles asignados:
${inputJson}`;
}

// ==================== LLM call ====================

async function callAnthropicRelations(clusterBatch) {
  const model = process.env.CONCEPT_RELATIONS_MODEL
    || process.env.CONCEPT_ROLES_MODEL
    || process.env.CONCEPT_CLUSTERING_MODEL
    || 'claude-sonnet-4-20250514';

  const response = await withRetry(
    () => getAnthropicClient().messages.create({
      model,
      max_tokens: 2500,
      temperature: 0.0,
      messages: [{ role: 'user', content: buildRelationsPrompt(clusterBatch) }],
    }),
    { label: 'callAnthropicRelations' },
  );

  return response.content
    .map(part => (part.type === 'text' ? part.text : ''))
    .join('\n')
    .trim();
}

// ==================== Persistence ====================

export async function persistRelations(relations, knownConceptIds, conceptMeta = {}) {
  const knownIds = new Set(knownConceptIds);

  const valid = relations.filter(r => {
    if (!r) return false;
    if (typeof r.source_concept_id !== 'string') return false;
    if (typeof r.target_concept_id !== 'string') return false;
    if (r.source_concept_id === r.target_concept_id) return false;
    if (!knownIds.has(r.source_concept_id)) return false;
    if (!knownIds.has(r.target_concept_id)) return false;
    if (!VALID_RELATION_TYPES.has(r.relation_type)) return false;
    if (typeof r.confidence !== 'number') return false;
    if (r.confidence < MIN_CONFIDENCE) return false;
    if (typeof r.rationale !== 'string') return false;
    if (r.rationale.trim().split(/\s+/).length < MIN_RATIONALE_WORDS) return false;

    // Drop low-signal → low-signal relations unless type is allowed
    if (!ALLOWED_LOW_SIGNAL.has(r.relation_type) && conceptMeta) {
      const src = conceptMeta[r.source_concept_id];
      const tgt = conceptMeta[r.target_concept_id];
      if (src && tgt) {
        const srcLow = LOW_SIGNAL_ROLES.has(src.role_in_cluster) || LOW_SIGNAL_TYPES.has(src.concept_type);
        const tgtLow = LOW_SIGNAL_ROLES.has(tgt.role_in_cluster) || LOW_SIGNAL_TYPES.has(tgt.concept_type);
        if (srcLow && tgtLow) return false;
      }
    }

    return true;
  });

  if (valid.length === 0) return 0;

  const sourceIds  = valid.map(r => r.source_concept_id);
  const targetIds  = valid.map(r => r.target_concept_id);
  const types      = valid.map(r => r.relation_type);
  const confs      = valid.map(r => r.confidence);
  const rationales = valid.map(r => r.rationale.trim());

  await dbPool.query(
    `INSERT INTO concept_relations
       (source_concept_id, target_concept_id, relation_type, confidence, rationale)
     SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::float[], $5::text[])
       AS u(source_concept_id, target_concept_id, relation_type, confidence, rationale)
     ON CONFLICT (source_concept_id, target_concept_id, relation_type) DO NOTHING`,
    [sourceIds, targetIds, types, confs, rationales]
  );

  return valid.length;
}

// ==================== Public API ====================

export async function assignRelationsForDocument(documentId) {
  logger.info('[conceptRelations] Starting', { documentId });

  const { rows } = await dbPool.query(
    `SELECT c.id             AS concept_id,
            c.label,
            c.definition,
            c.concept_type,
            c.importance,
            c.role_in_cluster,
            cl.id            AS cluster_id,
            cl.name          AS cluster_name,
            cl.definition    AS cluster_definition
     FROM concepts c
     JOIN clusters cl ON cl.id = c.cluster_id
     WHERE cl.document_id = $1
     ORDER BY cl.created_at ASC, c.created_at ASC`,
    [documentId]
  );

  if (rows.length === 0) {
    logger.info('[conceptRelations] No clustered concepts', { documentId });
    return { persisted: 0 };
  }

  // Group by cluster; skip single-concept clusters (no pairs possible)
  const clusterMap  = new Map();
  const conceptMeta = {};

  for (const row of rows) {
    conceptMeta[row.concept_id] = {
      role_in_cluster: row.role_in_cluster ?? null,
      concept_type:    row.concept_type    ?? null,
    };

    if (!clusterMap.has(row.cluster_id)) {
      clusterMap.set(row.cluster_id, {
        cluster_id:         row.cluster_id,
        cluster_name:       row.cluster_name,
        cluster_definition: row.cluster_definition,
        concepts:           [],
      });
    }
    clusterMap.get(row.cluster_id).concepts.push({
      id:              row.concept_id,
      label:           row.label,
      definition:      row.definition,
      concept_type:    row.concept_type    ?? null,
      importance:      row.importance      ?? null,
      role_in_cluster: row.role_in_cluster ?? null,
    });
  }

  const allClusters   = [...clusterMap.values()].filter(cl => cl.concepts.length >= 2);
  const allConceptIds = rows.map(r => r.concept_id);
  let   totalPersisted = 0;

  for (let i = 0; i < allClusters.length; i += MAX_CLUSTERS_PER_BATCH) {
    const batch = allClusters.slice(i, i + MAX_CLUSTERS_PER_BATCH);

    logger.info('[conceptRelations] Batch', {
      documentId,
      batchIndex: Math.floor(i / MAX_CLUSTERS_PER_BATCH),
      clusters:   batch.length,
    });

    try {
      const raw    = await callAnthropicRelations(batch);
      const parsed = safeJsonParseArray(raw);
      const count  = await persistRelations(parsed, allConceptIds, conceptMeta);
      totalPersisted += count;
    } catch (err) {
      logger.warn('[conceptRelations] Batch failed, skipping', {
        documentId, batchStart: i, error: err.message,
      });
    }
  }

  logger.info('[conceptRelations] Done', { documentId, persisted: totalPersisted });
  return { persisted: totalPersisted };
}
