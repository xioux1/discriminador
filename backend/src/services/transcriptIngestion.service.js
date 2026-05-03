import { dbPool } from '../db/client.js';
import { createEmbedding } from './conceptExtractor.service.js';

const TURN_PATTERN = /^(\d{2}:\d{2}:\d{2})\s+[^:]+:\s+(.+)/;
const CHUNK_MAX_CHARS = 1200;

function parseTranscriptLines(rawText) {
  return rawText
    .split('\n')
    .map(line => {
      const match = line.match(TURN_PATTERN);
      if (!match) return null;
      return { timestamp: match[1], text: match[2].trim() };
    })
    .filter(Boolean);
}

function buildChunks(turns) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  function flushChunk() {
    if (current.length === 0) return;
    chunks.push({
      content: current.map(t => t.text).join(' '),
      timestamp_start: current[0].timestamp,
      timestamp_end: current[current.length - 1].timestamp,
      chunk_index: chunks.length,
    });
    current = [];
    currentLen = 0;
  }

  for (const turn of turns) {
    if (turn.text.length > CHUNK_MAX_CHARS) {
      // Flush any accumulated turns first
      flushChunk();

      // Split oversized turn into sub-chunks
      let pos = 0;
      while (pos < turn.text.length) {
        const slice = turn.text.slice(pos, pos + CHUNK_MAX_CHARS);
        chunks.push({
          content: slice,
          timestamp_start: turn.timestamp,
          timestamp_end: turn.timestamp,
          chunk_index: chunks.length,
        });
        pos += CHUNK_MAX_CHARS;
      }
    } else {
      if (currentLen + turn.text.length > CHUNK_MAX_CHARS && current.length > 0) {
        flushChunk();
      }
      current.push(turn);
      currentLen += turn.text.length;
    }
  }

  flushChunk();
  return chunks;
}

export async function ingestTranscript(documentId, rawText) {
  const turns = parseTranscriptLines(rawText);
  if (turns.length === 0) return 0;

  const chunks = buildChunks(turns);
  if (chunks.length === 0) return 0;

  const CONCURRENCY = 5;
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);
    const embeddings = await Promise.all(batch.map(c => createEmbedding(c.content)));

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const vectorString = `[${embeddings[j].join(',')}]`;
      await dbPool.query(
        `INSERT INTO transcript_chunks
           (document_id, content, timestamp_start, timestamp_end, chunk_index, embedding)
         VALUES ($1, $2, $3::interval, $4::interval, $5, $6::vector)`,
        [
          documentId,
          chunk.content,
          chunk.timestamp_start,
          chunk.timestamp_end,
          chunk.chunk_index,
          vectorString,
        ]
      );
    }
  }

  return chunks.length;
}
