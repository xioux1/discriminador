import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { extractHierarchy } from '../hierarchyExtractor.service.js';

let state;

function reset() {
  state = { runs: {}, chunks: [], concepts: [], edges: [] };
}

const mockClient = {
  async query(sql, params) {
    const s = sql.trim().toUpperCase();
    if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
    if (s.startsWith('INSERT INTO INGESTION_RUNS')) {
      const [id, , checksum] = params;
      state.runs[id] = { id, source_checksum: checksum, status: 'chunking' };
      return { rows: [{ id }] };
    }
    if (s.startsWith('UPDATE INGESTION_RUNS')) {
      const [id, status] = params;
      state.runs[id].status = status;
      return { rows: [] };
    }
    if (s.includes('FROM INGESTION_RUNS')) {
      const checksum = params[0];
      const found = Object.values(state.runs).find((r) => r.source_checksum === checksum && r.status === 'done');
      return { rows: found ? [{ id: found.id }] : [] };
    }
    if (s.startsWith('INSERT INTO CHUNKS')) { state.chunks.push({ id: params[0] }); return { rows: [] }; }
    if (s.startsWith('INSERT INTO CONCEPTS')) { state.concepts.push({ id: params[0] }); return { rows: [] }; }
    if (s.startsWith('INSERT INTO CHUNK_EDGES')) { state.edges.push({ from: params[1], to: params[2] }); return { rows: [] }; }
    return { rows: [] };
  },
  release() {},
};

const dbPool = { query: (...a) => mockClient.query(...a), connect: async () => mockClient };
const mockPDF = async () => ({ text: '1\nTitulo\ntexto\f2\nOtro\nmas texto', numpages: 2 });
const mockRead = async () => Buffer.from('same');
const extractConceptsFromChunk = async () => ([{ canonical_label: 'A', description: null, confidence: 0.9 }]);

async function ingestTest(skipIfDone = true, flaky = false) {
  const buffer = await mockRead();
  const checksum = createHash('sha256').update(buffer).digest('hex');
  if (skipIfDone) {
    const { rows } = await dbPool.query('SELECT id FROM ingestion_runs WHERE source_checksum=$1 AND status=\'done\' LIMIT 1', [checksum]);
    if (rows[0]) return { runId: rows[0].id, skipped: true };
  }
  const runId = randomUUID();
  await dbPool.query('INSERT INTO ingestion_runs (id, source_uri, source_checksum, extraction_model, embedding_model, status) VALUES ($1,$2,$3,$4,$5,\'chunking\') RETURNING id', [runId, 'doc.pdf', checksum, 'm', 'e']);
  const doc = await mockPDF();
  const { chunks } = extractHierarchy(doc.text, { docTitle: 'Doc', forceMode: 'DENSE_PDF' });
  for (const c of chunks) await dbPool.query('INSERT INTO chunks ...', [randomUUID()]);
  await dbPool.query('UPDATE ingestion_runs SET status=$2 WHERE id=$1', [runId, 'extracting']);
  let i = 0;
  for (const c of chunks) {
    i++;
    try {
      if (flaky && i === 2) throw new Error('timeout');
      const concepts = await extractConceptsFromChunk(c.text, 8);
      for (const _ of concepts) await dbPool.query('INSERT INTO concepts ...', [randomUUID()]);
    } catch {}
  }
  for (let j = 0; j < Math.max(0, chunks.length - 1); j++) await dbPool.query('INSERT INTO chunk_edges ...', [randomUUID(), randomUUID(), randomUUID()]);
  await dbPool.query('UPDATE ingestion_runs SET status=$2 WHERE id=$1', [runId, 'done']);
  return { runId, skipped: false, chunksCount: chunks.length };
}

test('ingestion happy path', async () => {
  reset();
  const res = await ingestTest(true, false);
  assert.equal(res.skipped, false);
  assert.equal(state.runs[res.runId].status, 'done');
  assert.ok(state.chunks.length > 0);
  assert.ok(state.concepts.length > 0);
});

test('chunk failure does not fail run', async () => {
  reset();
  const res = await ingestTest(true, true);
  assert.equal(state.runs[res.runId].status, 'done');
});

test('dedup skips second run', async () => {
  reset();
  const first = await ingestTest(true, false);
  const second = await ingestTest(true, false);
  assert.equal(second.skipped, true);
  assert.equal(second.runId, first.runId);
});
