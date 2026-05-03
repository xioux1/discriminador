import { Router } from 'express';
import { dbPool } from '../db/client.js';
import { createEmbedding } from '../services/conceptExtractor.service.js';
import { ingestTranscript } from '../services/transcriptIngestion.service.js';

const router = Router();

router.post('/api/transcripts/ingest', async (req, res) => {
  const { document_id, raw_text } = req.body;
  if (!document_id || !raw_text) {
    return res.status(400).json({ error: 'document_id and raw_text are required' });
  }

  const chunks_created = await ingestTranscript(document_id, raw_text);
  res.json({ chunks_created });
});

router.post('/api/transcripts/search', async (req, res) => {
  const { query, document_id, top_k = 5 } = req.body;
  if (!query || !document_id) {
    return res.status(400).json({ error: 'query and document_id are required' });
  }

  const embedding = await createEmbedding(query);
  const vectorString = `[${embedding.join(',')}]`;

  const { rows } = await dbPool.query(
    `SELECT
       id AS chunk_id,
       content,
       TO_CHAR(timestamp_start, 'HH24:MI:SS') AS timestamp_start,
       TO_CHAR(timestamp_end,   'HH24:MI:SS') AS timestamp_end,
       1 - (embedding <=> $1) AS similarity
     FROM transcript_chunks
     WHERE document_id = $2
     ORDER BY embedding <=> $1
     LIMIT $3`,
    [vectorString, document_id, Number(top_k)]
  );

  res.json(rows);
});

export default router;
