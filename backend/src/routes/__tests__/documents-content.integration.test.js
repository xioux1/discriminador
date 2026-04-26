import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import conceptsRouter from '../concepts.routes.js';
import { dbPool } from '../../db/client.js';

// ── DB mock helpers ───────────────────────────────────────────────────────────

const originalQuery = dbPool.query;
afterEach(() => { dbPool.query = originalQuery; });

function mockDocumentQuery(doc) {
  dbPool.query = async (sql, params) => {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (compact.includes('FROM documents') && compact.includes('COALESCE(text, content, transcript)')) {
      if (!doc) return { rows: [] };
      return { rows: [doc] };
    }
    return { rows: [] };
  };
}

// ── Test server ───────────────────────────────────────────────────────────────

async function withServer(runTest) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 1 }; next(); });
  app.use(conceptsRouter);

  const server = http.createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  try {
    await runTest(base);
  } finally {
    await new Promise(r => server.close(r));
  }
}

async function get(base, path) {
  return new Promise((resolve, reject) => {
    http.get(base + path, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    }).on('error', reject);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test('GET /api/documents/:id/content returns 400 for invalid UUID', async () => {
  await withServer(async (base) => {
    const r = await get(base, '/api/documents/not-a-uuid/content');
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_id');
  });
});

test('GET /api/documents/:id/content returns 404 when document not found', async () => {
  const validId = '00000000-0000-0000-0000-000000000001';
  mockDocumentQuery(null);
  await withServer(async (base) => {
    const r = await get(base, `/api/documents/${validId}/content`);
    assert.equal(r.status, 404);
    assert.equal(r.body.error, 'not_found');
  });
});

test('GET /api/documents/:id/content returns text and word_count', async () => {
  const validId = '00000000-0000-0000-0000-000000000002';
  mockDocumentQuery({
    id: validId,
    original_filename: 'clase5.txt',
    subject: 'Derecho Civil',
    status: 'ready',
    created_at: new Date().toISOString(),
    document_text: 'El derecho civil regula las relaciones entre particulares.',
  });
  await withServer(async (base) => {
    const r = await get(base, `/api/documents/${validId}/content`);
    assert.equal(r.status, 200);
    assert.equal(r.body.id, validId);
    assert.equal(r.body.subject, 'Derecho Civil');
    assert.ok(typeof r.body.text === 'string', 'text should be a string');
    assert.ok(r.body.text.length > 0, 'text should not be empty');
    assert.ok(typeof r.body.word_count === 'number', 'word_count should be a number');
    assert.ok(r.body.word_count > 0, 'word_count should be > 0');
  });
});

test('GET /api/documents/:id/content returns word_count=0 when text is empty', async () => {
  const validId = '00000000-0000-0000-0000-000000000003';
  mockDocumentQuery({
    id: validId,
    original_filename: null,
    subject: null,
    status: 'ready',
    created_at: new Date().toISOString(),
    document_text: '',
  });
  await withServer(async (base) => {
    const r = await get(base, `/api/documents/${validId}/content`);
    assert.equal(r.status, 200);
    assert.equal(r.body.word_count, 0);
  });
});

test('GET /api/documents/:id/content returns null subject when document has none', async () => {
  const validId = '00000000-0000-0000-0000-000000000004';
  mockDocumentQuery({
    id: validId,
    original_filename: 'sin_materia.txt',
    subject: null,
    status: 'ready',
    created_at: new Date().toISOString(),
    document_text: 'Texto sin materia asignada.',
  });
  await withServer(async (base) => {
    const r = await get(base, `/api/documents/${validId}/content`);
    assert.equal(r.status, 200);
    assert.equal(r.body.subject, null);
    assert.ok(r.body.text.length > 0);
  });
});
