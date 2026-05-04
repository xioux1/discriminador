import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

let _anthropic = null;
function getClient() {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: Number(process.env.CHINESE_PARSE_TIMEOUT_MS || 90_000),
    });
  }
  return _anthropic;
}

// Sonnet for extraction (needs to handle messy handwritten-style notes reliably)
const EXTRACT_MODEL = process.env.CHINESE_EXTRACT_MODEL || 'claude-sonnet-4-6';
// Haiku is enough for clustering (well-structured task over clean concept list)
const CLUSTER_MODEL  = process.env.CHINESE_CLUSTER_MODEL  || 'claude-haiku-4-5-20251001';

// ==================== extractConceptsForChineseDocument ====================
// Uses Sonnet to parse class notes into granular concepts.
// One concept per USAGE of a word (别 as "no imperativo" and 别 as "otro" → 2 concepts).

export async function extractConceptsForChineseDocument(documentId) {
  const { rows: docRows } = await dbPool.query(
    `SELECT id, COALESCE(text, content, transcript) AS body FROM documents WHERE id = $1`,
    [documentId]
  );
  if (!docRows.length) throw new Error('Document not found');
  const text = (docRows[0].body || '').trim();
  if (!text) throw new Error('Document has no text');

  logger.info('[chineseParser] Extracting Chinese concepts', { documentId, chars: text.length });

  const msg = await getClient().messages.create({
    model: EXTRACT_MODEL,
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: `Analizá estos apuntes de clase de chino mandarín y extraé todos los conceptos de vocabulario y gramática.

REGLAS:
- Creá UN concepto por cada USO DISTINTO de una palabra. Si 别 significa "no imperativo" Y "otro/otra", son DOS conceptos separados.
- Ignorá encabezados de lección (第N课) y todo lo que esté después de 作业: (tarea).
- Si una oración de ejemplo no tiene traducción al español, dejá "es": null.
- label: "汉字 (pīnyīn) – uso específico" — si no hay hanzi visible, usá "(pīnyīn) – uso".
- definition: una oración en español que explique ESE uso específico de la palabra.
- evidence: las oraciones de ejemplo que demuestran ESE uso, en formato "汉字 → español".
- examples: array con los ejemplos que demuestran ese uso específico.

Apuntes:
${text}

Devolvé SOLO un array JSON válido con objetos:
{
  "hanzi": "字" | null,
  "pinyin": "pīnyīn",
  "label": "字 (pīnyīn) – descripción del uso",
  "definition": "Explicación en español de este uso específico.",
  "evidence": "我送你。→ Te acompaño.",
  "examples": [{"hanzi": "oración", "pinyin": "pīnyīn o null", "es": "traducción o null"}]
}

Sin markdown, sin texto extra.`,
    }],
  });

  const raw = msg.content?.[0]?.text?.trim() || '';
  const entries = parseJsonArray(raw, 'concept extraction');

  logger.info('[chineseParser] Concepts parsed', { documentId, count: entries.length });

  // Clear previous concepts for this document
  await dbPool.query('DELETE FROM concepts WHERE document_id = $1', [documentId]);

  const saved = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.pinyin && !e.hanzi) continue;

    const { rows } = await dbPool.query(
      `INSERT INTO concepts
         (document_id, label, definition, evidence, source_chunk, source_chunk_index, extraction_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, label, definition, evidence, source_chunk_index`,
      [
        documentId,
        e.label   || (e.hanzi ? `${e.hanzi} (${e.pinyin})` : `(${e.pinyin})`),
        e.definition || '',
        e.evidence   || null,
        JSON.stringify(e),   // full structured entry kept for card generation
        i,
        EXTRACT_MODEL,
      ]
    );
    saved.push(rows[0]);
  }

  logger.info('[chineseParser] Concepts stored', { documentId, count: saved.length });
  return saved;
}

// ==================== clusterConceptsForChineseDocument ====================
// Uses Haiku to group concepts by base word (all usages of 别 → 1 cluster).

export async function clusterConceptsForChineseDocument(documentId) {
  const { rows: concepts } = await dbPool.query(
    `SELECT id, label, definition
     FROM concepts
     WHERE document_id = $1
     ORDER BY source_chunk_index ASC NULLS LAST`,
    [documentId]
  );
  if (!concepts.length) throw new Error('No concepts to cluster for this document');

  logger.info('[chineseClustering] Clustering with LLM', { documentId, count: concepts.length });

  const conceptList = concepts.map(c => `ID:${c.id} | ${c.label} — ${c.definition}`).join('\n');

  const msg = await getClient().messages.create({
    model: CLUSTER_MODEL,
    max_tokens: 8192,
    messages: [{
      role: 'user',
      content: `Estos son conceptos de vocabulario chino extraídos de apuntes de clase. Agrupalos en clusters donde cada cluster represente UNA palabra base (mismo hanzi) con todos sus usos y patrones gramaticales.

Si un hanzi tiene múltiples usos (ej: 别 como imperativo y como adjetivo), todos deben ir en el MISMO cluster.
Si dos palabras distintas comparten el mismo hanzi pero con significados muy diferentes (homógrafos), pueden ir en clusters separados.

Conceptos:
${conceptList}

Para cada cluster devolvé:
- "name": "汉字 (pīnyīn)" — nombre corto del cluster
- "definition": una oración en español que resuma todos los usos agrupados
- "concept_ids": array con los IDs de los conceptos que pertenecen a este cluster

Devolvé SOLO un array JSON válido. Sin markdown.`,
    }],
  });

  const raw = msg.content?.[0]?.text?.trim() || '';
  const clusterDefs = parseJsonArray(raw, 'clustering');

  // Remove previous clusters
  await dbPool.query('DELETE FROM clusters WHERE document_id = $1', [documentId]);

  const conceptIdSet = new Set(concepts.map(c => c.id));
  const conceptMap   = new Map(concepts.map(c => [c.id, c]));
  const assigned = new Set();
  const result = [];

  for (const def of clusterDefs) {
    if (!def.name || !Array.isArray(def.concept_ids) || def.concept_ids.length === 0) continue;

    const validIds = def.concept_ids.filter(id => conceptIdSet.has(id) && !assigned.has(id));
    if (validIds.length === 0) continue;

    const { rows } = await dbPool.query(
      `INSERT INTO clusters (document_id, name, definition)
       VALUES ($1, $2, $3)
       RETURNING id, name, definition`,
      [documentId, def.name, def.definition || def.name]
    );
    const cluster = rows[0];

    await dbPool.query(
      `UPDATE concepts SET cluster_id = $1 WHERE id = ANY($2::uuid[])`,
      [cluster.id, validIds]
    );

    for (const id of validIds) assigned.add(id);
    result.push({
      ...cluster,
      concepts: validIds.map(id => ({
        id,
        label:      conceptMap.get(id)?.label      ?? '',
        definition: conceptMap.get(id)?.definition ?? '',
      })),
    });
  }

  // Any concept the LLM missed → its own cluster
  const missed = concepts.filter(c => !assigned.has(c.id));
  for (const c of missed) {
    const { rows } = await dbPool.query(
      `INSERT INTO clusters (document_id, name, definition) VALUES ($1, $2, $3) RETURNING id, name, definition`,
      [documentId, c.label, c.definition]
    );
    await dbPool.query(
      `UPDATE concepts SET cluster_id = $1 WHERE id = $2`,
      [rows[0].id, c.id]
    );
    result.push({ ...rows[0], concepts: [{ id: c.id, label: c.label, definition: c.definition }] });
  }

  logger.info('[chineseClustering] Done', { documentId, clusterCount: result.length });
  return { cluster_count: result.length, clusters: result };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function parseJsonArray(raw, context) {
  const start = raw.indexOf('[');
  const end   = raw.lastIndexOf(']');
  if (start === -1 || end === -1) {
    throw new Error(`LLM did not return a JSON array for ${context}`);
  }
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new Error(`Failed to parse JSON array for ${context}: ${e.message}`);
  }
}
