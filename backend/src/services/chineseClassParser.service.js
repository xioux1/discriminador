import Anthropic from '@anthropic-ai/sdk';
import { dbPool } from '../db/client.js';
import { logger } from '../utils/logger.js';

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) {
    _anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: Number(process.env.CHINESE_PARSE_TIMEOUT_MS || 60_000),
    });
  }
  return _anthropic;
}

export const CHINESE_PARSE_MODEL = process.env.CHINESE_PARSE_MODEL || 'claude-haiku-4-5-20251001';

// ==================== parseChineseNotes ====================
// Single LLM call (Haiku) to extract structured vocab entries from class notes.
// Returns an array of entry objects: { hanzi, pinyin, meanings, examples }

export async function parseChineseNotes(text) {
  const anthropic = getAnthropicClient();

  const msg = await anthropic.messages.create({
    model: CHINESE_PARSE_MODEL,
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are analyzing Chinese language class notes. Extract ALL vocabulary entries and their associated example sentences.

For EACH vocabulary entry found, return a JSON object with:
- "hanzi": the Chinese character(s) if present (e.g. "送"), or null if not written
- "pinyin": the pinyin romanization with tone marks (e.g. "sòng")
- "meanings": array of Spanish meanings (e.g. ["enviar", "regalar", "acompañar para despedir"])
- "examples": array of objects {hanzi: sentence in Chinese characters, pinyin: pinyin of sentence or null, es: Spanish translation or null}

Rules:
- Each vocabulary entry is identified by a line containing ">" with Spanish meanings on the right side
- Example sentences BELOW a vocabulary entry belong to THAT entry
- Ignore lesson headers like 第N课
- Ignore homework sections (作业: and everything after it)
- Ignore homework instruction lines (e.g. "Hacer una oración con...", "Después de unir...")
- If a sentence has NO Spanish translation, set es: null
- If a vocabulary entry has NO hanzi character written, set hanzi: null
- Include ALL vocabulary entries and ALL their example sentences
- A standalone sentence before the first vocab entry should be attached to the closest vocab entry below it

Notes:
${text}

Return ONLY a valid JSON array. No markdown, no explanation.`,
    }],
  });

  const raw = msg.content?.[0]?.text?.trim() || '';
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start === -1 || end === -1) throw new Error('LLM did not return a JSON array for Chinese parsing');

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('Failed to parse Chinese notes response as JSON array');
  }
}

// ==================== extractConceptsForChineseDocument ====================

export async function extractConceptsForChineseDocument(documentId) {
  const { rows: docRows } = await dbPool.query(
    `SELECT id, COALESCE(text, content, transcript) AS body FROM documents WHERE id = $1`,
    [documentId]
  );
  if (!docRows.length) throw new Error('Document not found');

  const text = (docRows[0].body || '').trim();
  if (!text) throw new Error('Document has no text');

  logger.info('[chineseParser] Parsing Chinese notes', { documentId, chars: text.length });

  const entries = await parseChineseNotes(text);
  logger.info('[chineseParser] Parsed entries', { documentId, count: entries.length });

  // Clear any previous concepts for this document
  await dbPool.query('DELETE FROM concepts WHERE document_id = $1', [documentId]);

  const saved = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry.pinyin && !entry.hanzi) continue;

    const label = entry.hanzi
      ? `${entry.hanzi} (${entry.pinyin || '?'})`
      : `(${entry.pinyin})`;

    const meanings = (entry.meanings || []).join(' / ');
    const definition = meanings || 'Palabra en chino';

    // Build evidence string from translated examples
    const evidenceParts = (entry.examples || [])
      .filter(ex => ex.hanzi)
      .map(ex => {
        const parts = [ex.hanzi];
        if (ex.pinyin) parts.push(`(${ex.pinyin})`);
        if (ex.es) parts.push(`→ ${ex.es}`);
        return parts.join(' ');
      });
    const evidence = evidenceParts.join(' | ') || null;

    // source_chunk stores full structured entry as JSON for card generation
    const sourceChunk = JSON.stringify(entry);

    const { rows } = await dbPool.query(
      `INSERT INTO concepts
         (document_id, label, definition, evidence, source_chunk, source_chunk_index, extraction_model)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, label, definition, evidence, source_chunk_index`,
      [documentId, label, definition, evidence, sourceChunk, i, CHINESE_PARSE_MODEL]
    );
    saved.push(rows[0]);
  }

  logger.info('[chineseParser] Concepts stored', { documentId, count: saved.length });
  return saved;
}

// ==================== clusterConceptsForChineseDocument ====================
// Deterministic: 1 concept = 1 cluster. No embeddings, no LLM needed.

export async function clusterConceptsForChineseDocument(documentId) {
  const { rows: concepts } = await dbPool.query(
    `SELECT id, label, definition
     FROM concepts
     WHERE document_id = $1 AND cluster_id IS NULL
     ORDER BY source_chunk_index ASC NULLS LAST`,
    [documentId]
  );

  if (!concepts.length) throw new Error('No concepts to cluster for this document');

  // Remove existing clusters (in case of re-clustering)
  await dbPool.query('DELETE FROM clusters WHERE document_id = $1', [documentId]);

  logger.info('[chineseClustering] Creating 1:1 clusters', { documentId, count: concepts.length });

  const clusters = [];
  for (const concept of concepts) {
    const { rows } = await dbPool.query(
      `INSERT INTO clusters (document_id, name, definition)
       VALUES ($1, $2, $3)
       RETURNING id, name, definition, created_at`,
      [documentId, concept.label, concept.definition]
    );
    const cluster = rows[0];

    await dbPool.query(
      `UPDATE concepts SET cluster_id = $1 WHERE id = $2`,
      [cluster.id, concept.id]
    );

    clusters.push({ ...cluster, concepts: [{ id: concept.id, label: concept.label }] });
  }

  logger.info('[chineseClustering] Done', { documentId, clusterCount: clusters.length });

  return {
    cluster_count: clusters.length,
    clusters,
  };
}
