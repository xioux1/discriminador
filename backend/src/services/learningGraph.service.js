import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';
import { withRetry } from '../utils/retry.js';

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: Number(process.env.LEARNING_GRAPH_LLM_TIMEOUT_MS || 90_000),
  });
  return _anthropic;
}

const MODEL = process.env.LEARNING_GRAPH_MODEL || 'claude-sonnet-4-20250514';

// ── Document context fetch ────────────────────────────────────────────────────

async function fetchDocumentContext(documentId) {
  const { rows: docRows } = await dbPool.query(
    `SELECT document_structure_json, generated_markdown, text
     FROM documents WHERE id = $1`,
    [documentId]
  );
  if (!docRows.length) return null;
  const doc = docRows[0];

  const { rows: sections } = await dbPool.query(
    `SELECT title, order_index, section_type, summary
     FROM document_sections WHERE document_id = $1
     ORDER BY order_index ASC`,
    [documentId]
  );

  const rawText = doc.generated_markdown || doc.text || '';
  const textSnippet = rawText.split(/\s+/).slice(0, 2000).join(' ');

  return {
    structure: doc.document_structure_json || null,
    sections,
    textSnippet,
  };
}

// ── Prompts ───────────────────────────────────────────────────────────────────

function buildDocumentMapPrompt(clusters, docContext) {
  const { structure, sections, textSnippet } = docContext;

  const topics = clusters.map(c => ({
    id: c.id,
    name: c.name,
    definition: c.definition || '',
    available_concepts: (c.concepts || []).slice(0, 20).map(x => x.label),
  }));

  const mainTopic    = structure?.main_topic    || 'Tema del documento';
  const structType   = structure?.structure_type || 'mixed';
  const primaryAxis  = structure?.primary_axis   || '';

  const sectionsBlock = sections.length
    ? `Secciones/etapas del documento:\n${sections.map(s =>
        `${s.order_index}. ${s.title}${s.summary ? ' — ' + s.summary.slice(0, 100) : ''}`
      ).join('\n')}`
    : '';

  const textBlock = textSnippet
    ? `Fragmento del documento (primeras 2000 palabras):\n---\n${textSnippet}\n---`
    : '';

  const structureGuide = {
    process_stages: 'los pilares son las fases principales del proceso',
    taxonomy:       'los pilares son las categorías o dimensiones de clasificación',
    comparison:     'los pilares son los criterios de comparación entre elementos',
    concept_lesson: 'los pilares son los subtemas conceptuales principales',
    case_study:     'los pilares son las dimensiones del caso (contexto, problema, solución, resultado)',
    mixed:          'los pilares son los grandes ejes temáticos del contenido',
  }[structType] || 'los pilares son los grandes ejes temáticos del contenido';

  return `Sos un experto en pedagogía y cartografía conceptual. Tu tarea es generar un mapa conceptual jerárquico top-down para un material de estudio.

## DOCUMENTO

Tema principal: ${mainTopic}
Tipo de estructura: ${structType}
Eje organizativo: ${primaryAxis}

${sectionsBlock}

${textBlock}

## CLUSTERS IDENTIFICADOS

${JSON.stringify(topics, null, 2)}

## INSTRUCCIONES

Generá una jerarquía de 4 niveles que refleje la estructura NARRATIVA del documento:

NIVEL 1 — RAÍZ: el tema central del documento (1 nodo, extraído del contenido)
NIVEL 2 — PILARES: 2 a 5 grandes ejes temáticos
  - Para este documento (${structType}): ${structureGuide}
  - Nombres en español, 2-4 palabras, frases nominales
  - Los pilares deben reflejar la estructura NARRATIVA del documento, no la dificultad pedagógica
NIVEL 3 — CLUSTERS: cada cluster asignado a exactamente un pilar
  - TODOS los cluster_ids deben aparecer exactamente una vez
NIVEL 4 — CONCEPTOS: 3-6 por cluster, elegidos de available_concepts
  - Incluir: constructos teóricos, mecanismos, relaciones, principios, terminología clave
  - Excluir: pasos procedimentales, valores numéricos específicos, ejemplos concretos genéricos
  - Para cada concepto elegido, clasificá su tipo:
    "fase" (etapa de un proceso) | "actividad" (acción a realizar) | "herramienta" (software, sistema, tecnología)
    "documento" (entregable formal escrito) | "entregable" (output concreto) | "concepto" (idea abstracta) | "actor" (persona o rol)
  - Si el cluster tiene 5 o más conceptos, agrupalos en 2-3 sub_groups con nombres cortos (2-3 palabras).
    Los sub_groups reflejan distinciones reales del contenido (ej: "Preparación / Ejecución / Cierre").
    Si no hay agrupación natural clara, omití sub_groups (no forzar).

Además, generá una SECUENCIA DE ESTUDIO (orden pedagógico, independiente de la jerarquía visual):
  - learning_order: 1 = estudiar primero, mayor = estudiar después
  - learning_level: "foundational" | "intermediate" | "advanced"
  - requires: cluster_ids que deben entenderse antes (sin referencias circulares, solo IDs con menor learning_order)
  - Todos los cluster_ids deben aparecer exactamente una vez

Además, generá RELACIONES ENTRE CLUSTERS (cross_cluster_edges): 3-6 conexiones semánticas no triviales entre clusters de distintos pilares.
  - Solo relaciones que aporten comprensión real, no relaciones puramente secuenciales
  - edge_type: "enables" | "motivates" | "part_of" | "contrasts_with" | "formula_for"
  - label: frase corta en español de 2-5 palabras que describe la relación específica (ej: "fundamenta el cálculo de", "motiva el diseño de", "requiere comprender")
  - Evitá repetir relaciones ya implícitas en la jerarquía (padre-hijo)

Respondé SOLO con JSON válido, sin markdown, sin texto adicional:

{
  "document_topic": "<tema en 4-8 palabras>",
  "pillars": [
    {
      "id": "p1",
      "name": "<nombre del pilar en español>",
      "clusters": [
        {
          "cluster_id": "<uuid>",
          "key_concepts": ["<label>", "<label>", "<label>"],
          "concept_types": [
            { "label": "<label>", "type": "herramienta|fase|actividad|documento|entregable|concepto|actor" }
          ],
          "sub_groups": [
            { "group_name": "<2-3 palabras>", "concepts": ["<label>", "<label>"] }
          ]
        }
      ]
    }
  ],
  "sequence": [
    { "cluster_id": "<uuid>", "learning_order": 1, "learning_level": "foundational", "requires": [] }
  ],
  "cross_cluster_edges": [
    { "from_cluster_id": "<uuid>", "to_cluster_id": "<uuid>", "edge_type": "enables", "label": "<frase en español>" }
  ]
}`;
}

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

async function callLLM(clusters, docContext) {
  const maxTokens = Math.max(4096, clusters.length * 1200);
  const prompt = docContext
    ? buildDocumentMapPrompt(clusters, docContext)
    : buildPrompt(clusters);

  const response = await withRetry(() =>
    getAnthropicClient().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    })
  );

  const raw = response.content?.[0]?.text?.trim() ?? '';
  const jsonText = raw.replace(/^```(?:json)?\n?/i, '').replace(/\n?```$/i, '').trim();

  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed?.sequence)) throw new Error('Missing sequence array');

    // New hierarchical format
    if (Array.isArray(parsed?.pillars)) return parsed;

    // Old flat format fallback
    if (parsed?.concept_map) return parsed;

    throw new Error('Missing pillars and concept_map');
  } catch {
    logger.warn('[learningGraph] Failed to parse LLM response', { raw: raw.slice(0, 500) });
    return null;
  }
}

// ── Normalisation ─────────────────────────────────────────────────────────────

function normaliseSequence(sequence, clusterIds) {
  const idSet = new Set(clusterIds);
  const seen  = new Set();
  const clean = [];

  for (const item of sequence) {
    if (!idSet.has(item.cluster_id)) continue;
    if (seen.has(item.cluster_id))   continue;
    seen.add(item.cluster_id);

    const safeRequires = (item.requires ?? []).filter(r => idSet.has(r) && seen.has(r));
    clean.push({ ...item, requires: safeRequires });
  }

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
  const { sequence, concept_map, pillars } = llmResult;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      'DELETE FROM cluster_dependencies WHERE document_id = $1',
      [documentId]
    );

    await client.query(
      `UPDATE clusters SET learning_order = NULL, learning_level = NULL,
         block_name = NULL, is_center = FALSE, key_map_concepts = '[]'::jsonb
       WHERE document_id = $1`,
      [documentId]
    );

    // Write sequence
    for (const item of sequence) {
      await client.query(
        `UPDATE clusters
         SET learning_order = $1, learning_level = $2
         WHERE id = $3 AND document_id = $4`,
        [item.learning_order, item.learning_level, item.cluster_id, documentId]
      );
    }

    if (Array.isArray(pillars)) {
      // New hierarchical format: derive block_name and key_map_concepts from pillars
      for (const pillar of pillars) {
        for (const cl of (pillar.clusters ?? [])) {
          await client.query(
            `UPDATE clusters SET block_name = $1 WHERE id = $2 AND document_id = $3`,
            [pillar.name, cl.cluster_id, documentId]
          );
          const concepts = (cl.key_concepts ?? []).filter(c => typeof c === 'string').slice(0, 6);
          if (concepts.length) {
            await client.query(
              `UPDATE clusters SET key_map_concepts = $1::jsonb WHERE id = $2 AND document_id = $3`,
              [JSON.stringify(concepts), cl.cluster_id, documentId]
            );
          }
        }
      }
    } else {
      // Old flat format
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

      if (concept_map?.center_cluster_id) {
        await client.query(
          `UPDATE clusters SET is_center = TRUE WHERE id = $1 AND document_id = $2`,
          [concept_map.center_cluster_id, documentId]
        );
      }

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
    }

    // Sequence dependency edges
    for (const item of sequence) {
      for (const reqId of (item.requires ?? [])) {
        await client.query(
          `INSERT INTO cluster_dependencies (document_id, from_cluster_id, to_cluster_id, edge_semantic_type)
           VALUES ($1, $2, $3, 'requires')
           ON CONFLICT (from_cluster_id, to_cluster_id) DO NOTHING`,
          [documentId, reqId, item.cluster_id]
        );
      }
    }

    // Cross-cluster edges (new hierarchical format)
    if (Array.isArray(pillars) && Array.isArray(llmResult.cross_cluster_edges)) {
      for (const edge of llmResult.cross_cluster_edges) {
        if (!edge.from_cluster_id || !edge.to_cluster_id) continue;
        if (edge.from_cluster_id === edge.to_cluster_id) continue;
        await client.query(
          `INSERT INTO cluster_dependencies
             (document_id, from_cluster_id, to_cluster_id, edge_label, edge_semantic_type)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (from_cluster_id, to_cluster_id) DO UPDATE
             SET edge_label = EXCLUDED.edge_label,
                 edge_semantic_type = EXCLUDED.edge_semantic_type`,
          [documentId, edge.from_cluster_id, edge.to_cluster_id,
           edge.label ?? null, edge.edge_type ?? null]
        );
      }
    }

    // Concept map edges (old format only)
    if (!Array.isArray(pillars) && Array.isArray(concept_map?.edges)) {
      for (const edge of concept_map.edges) {
        if (!edge.from_cluster_id || !edge.to_cluster_id) continue;
        if (edge.from_cluster_id === edge.to_cluster_id) continue;
        await client.query(
          `INSERT INTO cluster_dependencies
             (document_id, from_cluster_id, to_cluster_id, edge_label, edge_semantic_type)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (from_cluster_id, to_cluster_id) DO UPDATE
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

async function persistConceptMapTree(documentId, llmResult) {
  if (!Array.isArray(llmResult.pillars) || !llmResult.document_topic) return;

  const tree = {
    document_topic: llmResult.document_topic,
    pillars: llmResult.pillars,
    generated_at: new Date().toISOString(),
  };

  await dbPool.query(
    `UPDATE documents SET concept_map_tree_json = $1 WHERE id = $2`,
    [JSON.stringify(tree), documentId]
  );
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds and persists a pedagogical learning graph + hierarchical concept map tree.
 */
export async function buildLearningGraph(documentId, clusters) {
  if (!clusters || clusters.length < 2) {
    logger.info('[learningGraph] Skipping — fewer than 2 clusters', { documentId });
    return;
  }

  logger.info('[learningGraph] Building learning graph', { documentId, clusterCount: clusters.length });

  const docContext = await fetchDocumentContext(documentId).catch(err => {
    logger.warn('[learningGraph] Could not fetch doc context (non-fatal)', {
      documentId, error: err.message,
    });
    return null;
  });

  const llmResult = await callLLM(clusters, docContext);

  if (!llmResult) {
    logger.warn('[learningGraph] LLM returned unparseable response, skipping', { documentId });
    return;
  }

  const clusterIds = clusters.map(c => c.id);
  const normalisedSequence = normaliseSequence(llmResult.sequence, clusterIds);
  if (!normalisedSequence) {
    logger.warn('[learningGraph] Sequence normalisation produced empty result, skipping', { documentId });
    return;
  }

  await Promise.all([
    persistLearningGraph(documentId, { ...llmResult, sequence: normalisedSequence }),
    persistConceptMapTree(documentId, llmResult),
  ]);

  logger.info('[learningGraph] Learning graph persisted', {
    documentId,
    sequenceLength: normalisedSequence.length,
    hasPillars: Array.isArray(llmResult.pillars),
    pillarCount: llmResult.pillars?.length ?? 0,
  });
}

/**
 * Returns the learning graph for a document, including the hierarchical tree if available.
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

  const blockMap = {};
  for (const c of clusters) {
    const key = c.block_name ?? 'Sin clasificar';
    (blockMap[key] ??= []).push(c.id);
  }
  const blocks = Object.entries(blockMap).map(([block_name, cluster_ids]) => ({
    block_name,
    cluster_ids,
  }));

  const edges = deps
    .filter(d => d.edge_semantic_type && d.edge_semantic_type !== 'requires')
    .map(d => ({
      from_cluster_id: d.from_cluster_id,
      to_cluster_id: d.to_cluster_id,
      edge_type: d.edge_semantic_type,
      label: d.edge_label,
    }));

  const center = clusters.find(c => c.is_center);

  // Fetch high-confidence intra-cluster concept relations
  const { rows: conceptRels } = await dbPool.query(
    `SELECT
       c_src.cluster_id,
       c_src.label AS source_label,
       c_tgt.label AS target_label,
       cr.relation_type,
       cr.confidence
     FROM concept_relations cr
     JOIN concepts c_src ON c_src.id = cr.source_concept_id
     JOIN concepts c_tgt ON c_tgt.id = cr.target_concept_id
     WHERE c_src.document_id = $1
       AND c_src.cluster_id IS NOT NULL
       AND c_src.cluster_id = c_tgt.cluster_id
       AND cr.confidence >= 0.65
     ORDER BY c_src.cluster_id, cr.confidence DESC`,
    [documentId]
  );

  const relsByCluster = {};
  for (const rel of conceptRels) {
    const arr = (relsByCluster[rel.cluster_id] ??= []);
    if (arr.length < 3) arr.push({ source: rel.source_label, target: rel.target_label, type: rel.relation_type });
  }

  // Load hierarchical tree and enrich with cluster names, relations, and cross-cluster edges
  const { rows: docRows } = await dbPool.query(
    `SELECT concept_map_tree_json FROM documents WHERE id = $1`,
    [documentId]
  );
  let treeJson = docRows[0]?.concept_map_tree_json ?? null;

  if (treeJson?.pillars) {
    const clusterById = {};
    clusters.forEach(c => { clusterById[c.id] = c; });
    treeJson = {
      ...treeJson,
      pillars: treeJson.pillars.map(p => ({
        ...p,
        clusters: (p.clusters ?? []).map(cl => ({
          ...cl,
          cluster_name: clusterById[cl.cluster_id]?.name ?? cl.cluster_id,
          relations: relsByCluster[cl.cluster_id] ?? [],
        })),
      })),
      edges,
    };
  }

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
    concept_map_tree: treeJson,
  };
}
