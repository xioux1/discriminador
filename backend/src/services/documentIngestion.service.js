import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

import { dbPool } from '../db/client.js';
import { extractHierarchy } from './hierarchyExtractor.service.js';
import { extractConceptsFromChunk } from './conceptExtractor.service.js';
import { logger } from '../utils/logger.js';
import { embedAndBuildSemanticGraph } from './chunkEmbedding.service.js';

const EXTRACTION_MODEL = process.env.CONCEPT_EXTRACTION_MODEL || 'claude-sonnet-4-20250514';
const EMBEDDING_MODEL = process.env.CONCEPT_EMBEDDING_MODEL || 'voyage-large-2';
const MAX_CONCEPTS_PER_CHUNK = Number(process.env.CONCEPTS_PER_INGESTION_CHUNK || 8);

let _PDFParse = null;
async function getPDFParse() {
  if (!_PDFParse) {
    const mod = await import('pdf-parse');
    _PDFParse = mod.PDFParse;
  }
  return _PDFParse;
}

async function createRun({ sourceUri, sourceChecksum }) {
  const { rows } = await dbPool.query(
    `INSERT INTO ingestion_runs
       (id, source_uri, source_checksum, extraction_model, embedding_model, status)
     VALUES ($1,$2,$3,$4,$5,'chunking')
     RETURNING id`,
    [randomUUID(), sourceUri, sourceChecksum, EXTRACTION_MODEL, EMBEDDING_MODEL]
  );
  return rows[0].id;
}

async function updateRunStatus(runId, status, errorMessage = null) {
  await dbPool.query(
    `UPDATE ingestion_runs
        SET status = $2,
            error_message = $3,
            finished_at = CASE WHEN $2 IN ('done','failed') THEN now() ELSE NULL END
      WHERE id = $1`,
    [runId, status, errorMessage]
  );
}

async function findExistingRun(checksum) {
  const { rows } = await dbPool.query(
    `SELECT id FROM ingestion_runs
      WHERE source_checksum = $1 AND status = 'done'
      LIMIT 1`,
    [checksum]
  );
  return rows[0] ?? null;
}

async function persistChunks(runId, rawChunks) {
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    const inserted = [];
    for (const chunk of rawChunks) {
      const id = randomUUID();
      await client.query(
        `INSERT INTO chunks
           (id, run_id, chunk_index, position_in_doc, page_start, page_end,
            token_count, text, structural_path, depth)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          runId,
          chunk.chunk_index,
          chunk.position_in_doc,
          chunk.page_start ?? null,
          chunk.page_end ?? null,
          chunk.text.split(/\s+/).filter(Boolean).length,
          chunk.text,
          chunk.structural_path,
          chunk.depth,
        ]
      );
      inserted.push({ ...chunk, id });
    }
    await client.query('COMMIT');
    return inserted;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function extractAndPersistConcepts(chunks) {
  const client = await dbPool.connect();
  const all = [];
  try {
    for (const chunk of chunks) {
      let concepts;
      try {
        concepts = await extractConceptsFromChunk(chunk.text, MAX_CONCEPTS_PER_CHUNK);
      } catch (err) {
        logger.warn('[documentIngestion] chunk extraction failed', {
          chunkIndex: chunk.chunk_index,
          message: err.message,
        });
        continue;
      }

      if (!concepts.length) continue;

      await client.query('BEGIN');
      try {
        for (const concept of concepts) {
          await client.query(
            `INSERT INTO concepts
               (id, chunk_id, canonical_label, description, confidence,
                extraction_model, structural_path, depth)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              randomUUID(),
              chunk.id,
              concept.canonical_label,
              concept.description ?? null,
              concept.confidence ?? null,
              EXTRACTION_MODEL,
              chunk.structural_path,
              chunk.depth,
            ]
          );
          all.push(concept);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.warn('[documentIngestion] chunk concept persistence failed', {
          chunkIndex: chunk.chunk_index,
          message: err.message,
        });
      }
    }
  } finally {
    client.release();
  }
  return all;
}

async function insertStructuralEdges(chunks) {
  if (chunks.length < 2) return;
  const client = await dbPool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < chunks.length - 1; i++) {
      await client.query(
        `INSERT INTO chunk_edges
           (id, from_chunk_id, to_chunk_id, edge_type, weight, metadata)
         VALUES ($1,$2,$3,'STRUCTURAL',1.0,'{}')
         ON CONFLICT DO NOTHING`,
        [randomUUID(), chunks[i].id, chunks[i + 1].id]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function ingestDocument({ filePath, docTitle, forceMode = null, skipIfDone = true }) {
  const buffer = await fs.readFile(filePath);
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const sourceUri = path.basename(filePath);

  if (skipIfDone) {
    const existing = await findExistingRun(checksum);
    if (existing) return { runId: existing.id, skipped: true };
  }

  const runId = await createRun({ sourceUri, sourceChecksum: checksum });

  try {
    const PDFParse = await getPDFParse();
    const parser = new PDFParse({ data: buffer });
    const doc = await parser.getText();

    await updateRunStatus(runId, 'chunking');
    const { mode, chunks: rawChunks } = extractHierarchy(doc.text, { docTitle, forceMode });
    if (!rawChunks.length) throw new Error('No chunks extracted');

    const persistedChunks = await persistChunks(runId, rawChunks);

    await updateRunStatus(runId, 'extracting');
    const concepts = await extractAndPersistConcepts(persistedChunks);

    await insertStructuralEdges(persistedChunks);

    await updateRunStatus(runId, 'embedding');
    const { embeddedCount, edgesCount } = await embedAndBuildSemanticGraph(runId);

    await updateRunStatus(runId, 'done');

    return {
      runId,
      mode,
      chunksCount: persistedChunks.length,
      conceptsCount: concepts.length,
      embeddedCount,
      edgesCount,
      skipped: false,
    };
  } catch (err) {
    await updateRunStatus(runId, 'failed', err.message);
    throw err;
  }
}

export async function ingestDocumentFromUpload(document, filePath) {
  return ingestDocument({
    filePath,
    docTitle: document.title ?? document.name ?? path.basename(filePath, '.pdf'),
    forceMode: document.processing_mode === 'pdf_visual' ? 'SLIDE_PDF' : null,
    skipIfDone: true,
  });
}
