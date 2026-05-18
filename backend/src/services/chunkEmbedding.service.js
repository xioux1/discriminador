import { randomUUID } from 'node:crypto';
import { dbPool } from '../db/client.js';
import { createEmbedding } from '../utils/voyage-embed.js';

const EMBEDDING_MODEL = process.env.CONCEPT_EMBEDDING_MODEL || 'voyage-large-2';
const SEMANTIC_THRESHOLD = parseFloat(process.env.SEMANTIC_SIMILARITY_THRESHOLD || '0.75');
const MAX_EDGES_PER_CHUNK = parseInt(process.env.SEMANTIC_MAX_EDGES_PER_CHUNK || '10', 10);
const EMBED_BATCH_SIZE = parseInt(process.env.EMBED_BATCH_SIZE || '32', 10);

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function embedChunksForRun(runId) {
  const { rows: chunks } = await dbPool.query(
    `SELECT id, text, chunk_index
       FROM chunks
      WHERE run_id = $1 AND embedding IS NULL
      ORDER BY chunk_index`,
    [runId]
  );

  let embeddedCount = 0;

  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    let embeddings;
    try {
      embeddings = await Promise.all(batch.map((c) => createEmbedding(c.text, EMBEDDING_MODEL)));
    } catch {
      continue;
    }

    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      for (let j = 0; j < batch.length; j++) {
        const emb = embeddings[j];
        if (!Array.isArray(emb)) continue;
        await client.query(
          `UPDATE chunks SET embedding = $1::vector, embedding_model = $2 WHERE id = $3`,
          [JSON.stringify(emb), EMBEDDING_MODEL, batch[j].id]
        );
        embeddedCount += 1;
      }
      await client.query('COMMIT');
    } catch {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }

  return embeddedCount;
}

export async function buildSemanticEdgesForRun(runId) {
  const { rows: chunks } = await dbPool.query(
    `SELECT id, chunk_index, embedding::text AS embedding_text
       FROM chunks
      WHERE run_id = $1 AND embedding IS NOT NULL
      ORDER BY chunk_index`,
    [runId]
  );

  if (chunks.length < 2) return 0;

  const parsed = chunks.map((c) => ({ ...c, vector: JSON.parse(c.embedding_text) }));
  const candidates = [];
  for (let i = 0; i < parsed.length; i++) {
    for (let j = i + 1; j < parsed.length; j++) {
      const sim = cosineSimilarity(parsed[i].vector, parsed[j].vector);
      if (sim >= SEMANTIC_THRESHOLD) {
        candidates.push({ from: parsed[i].id, to: parsed[j].id, similarity: sim });
      }
    }
  }

  const edgeCount = new Map();
  const filtered = candidates.sort((a, b) => b.similarity - a.similarity).filter((e) => {
    const a = edgeCount.get(e.from) ?? 0;
    const b = edgeCount.get(e.to) ?? 0;
    if (a >= MAX_EDGES_PER_CHUNK || b >= MAX_EDGES_PER_CHUNK) return false;
    edgeCount.set(e.from, a + 1);
    edgeCount.set(e.to, b + 1);
    return true;
  });

  const client = await dbPool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const e of filtered) {
      await client.query(
        `INSERT INTO chunk_edges
           (id, from_chunk_id, to_chunk_id, edge_type, weight, metadata)
         VALUES ($1,$2,$3,'SEMANTIC',$4,$5)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), e.from, e.to, Number(e.similarity.toFixed(6)), JSON.stringify({ similarity_model: EMBEDDING_MODEL })]
      );
      inserted += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return inserted;
}

export async function embedAndBuildSemanticGraph(runId) {
  const embeddedCount = await embedChunksForRun(runId);
  const edgesCount = await buildSemanticEdgesForRun(runId);
  return { embeddedCount, edgesCount };
}
