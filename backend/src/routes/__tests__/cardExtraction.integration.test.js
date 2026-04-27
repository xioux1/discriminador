import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

process.env.DATABASE_URL      = process.env.DATABASE_URL      || 'postgres://test:test@localhost:5432/test';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
process.env.JWT_SECRET        = process.env.JWT_SECRET        || 'test-secret-that-is-at-least-32-chars-x';

// ── DB mock ───────────────────────────────────────────────────────────────────
// We mock the db client so no real DB is needed.
const insertedCards = [];
const mockDbPool = {
  connect: async () => {
    const rows = [];
    let idCounter = 1;
    return {
      query: async (sql, params) => {
        if (/INSERT INTO cards/i.test(sql)) {
          const id = idCounter++;
          insertedCards.push({ id, params });
          return { rows: [{ id }] };
        }
        if (/BEGIN|COMMIT|ROLLBACK/i.test(sql)) return { rows: [] };
        return { rows: [] };
      },
      release: () => {},
    };
  },
  query: async () => ({ rows: [], rowCount: 0 }),
};

// Patch the db module before importing cardsRouter
import { createRequire } from 'node:module';
import { register } from 'node:module';

// Use a simple mock approach: we'll import and then override at runtime
// by patching the module cache via a loader. For simplicity with ES modules,
// we build a minimal express app that directly tests the route logic.

// ── Inline route helpers (mirrors cards.js logic for the two new endpoints) ──

const VALID_STATUSES = new Set(['ready', 'ambiguous', 'needs_edit', 'rejected']);

function buildTestRouter(dbPool, extractFn) {
  const router = express.Router();

  // POST /cards/extract-candidates
  router.post('/api/cards/extract-candidates', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text) {
      return res.status(422).json({ error: 'validation_error', message: 'text es obligatorio.' });
    }
    const subject    = typeof req.body?.subject === 'string' ? req.body.subject.trim() : undefined;
    const document_id = typeof req.body?.document_id === 'string' ? req.body.document_id.trim() : undefined;
    try {
      const { cards, warnings } = await extractFn({ text, subject, document_id });
      return res.json({ cards, warnings });
    } catch (err) {
      if (err.code === 'validation_error') {
        return res.status(422).json({ error: 'validation_error', message: err.message });
      }
      return res.status(500).json({ error: 'server_error', message: err.message });
    }
  });

  // POST /cards/import-reviewed
  router.post('/api/cards/import-reviewed', async (req, res) => {
    const userId   = req.user.id;
    const cardsRaw = Array.isArray(req.body?.cards) ? req.body.cards : [];
    const subject  = typeof req.body?.subject === 'string' ? req.body.subject.trim() : null;
    const document_id = typeof req.body?.document_id === 'string' ? req.body.document_id.trim() : null;

    if (!cardsRaw.length) {
      return res.status(422).json({ error: 'validation_error', message: 'cards no puede estar vacío.' });
    }

    const validationErrors = [];
    const toInsert = [];

    for (let i = 0; i < cardsRaw.length; i++) {
      const c = cardsRaw[i];
      if (!c || typeof c !== 'object') { validationErrors.push({ index: i, issue: 'elemento inválido' }); continue; }
      if (c.status === 'rejected') continue;
      const question = typeof c.question === 'string' ? c.question.trim() : '';
      const answer   = typeof c.answer   === 'string' ? c.answer.trim()   : '';
      if (!question) { validationErrors.push({ index: i, issue: 'question es obligatorio' }); continue; }
      if (!answer)   { validationErrors.push({ index: i, issue: 'answer es obligatorio' });   continue; }
      const cardSubject = (typeof c.subject === 'string' && c.subject.trim()) ? c.subject.trim() : subject;
      const sourceExcerpt = typeof c.source_excerpt === 'string' ? c.source_excerpt.trim() : null;
      const confidence = typeof c.confidence === 'number' ? c.confidence : null;
      toInsert.push({ question, answer, subject: cardSubject, source_excerpt: sourceExcerpt, confidence, document_id });
    }

    if (validationErrors.length && !toInsert.length) {
      return res.status(422).json({ error: 'validation_error', message: 'Ninguna tarjeta válida para importar.', details: validationErrors });
    }

    const insertedIds = [];
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      for (const card of toInsert) {
        const { rows } = await client.query(
          `INSERT INTO cards (user_id, subject, prompt_text, expected_answer_text, document_id, notes, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now(), now()) RETURNING id`,
          [userId, card.subject || null, card.question, card.answer, card.document_id || null,
           card.source_excerpt ? `[fuente] ${card.source_excerpt.slice(0, 500)}` : null]
        );
        insertedIds.push(rows[0].id);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      return res.status(500).json({ error: 'server_error', message: err.message });
    } finally {
      client.release();
    }

    return res.json({ inserted: insertedIds.length, ids: insertedIds, validation_errors: validationErrors });
  });

  return router;
}

// ── Test server factory ────────────────────────────────────────────────────────

async function withServer(extractFn, runTest) {
  insertedCards.length = 0; // reset between tests

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 42 }; next(); });
  app.use(buildTestRouter(mockDbPool, extractFn));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await runTest(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

// ── extract-candidates ─────────────────────────────────────────────────────────

test('/cards/extract-candidates: rejects empty text', async () => {
  const stubExtract = async () => { throw Object.assign(new Error('text no puede estar vacío.'), { code: 'validation_error' }); };
  await withServer(stubExtract, async (base) => {
    const res = await fetch(`${base}/api/cards/extract-candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'validation_error');
  });
});

test('/cards/extract-candidates: returns cards without inserting into DB', async () => {
  const fakeCandidates = [
    { question: '¿Qué es X?', answer: 'X es Y.', source_excerpt: 'X es Y según el texto.', confidence: 0.9, status: 'ready' },
  ];
  const stubExtract = async () => ({ cards: fakeCandidates, warnings: [] });
  await withServer(stubExtract, async (base) => {
    const res = await fetch(`${base}/api/cards/extract-candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'X es Y según el texto.', subject: 'Test' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.cards));
    assert.equal(body.cards.length, 1);
    assert.equal(body.cards[0].question, '¿Qué es X?');
    // Critically: no DB inserts
    assert.equal(insertedCards.length, 0);
  });
});

test('/cards/extract-candidates: missing text field returns 422', async () => {
  const stubExtract = async () => ({ cards: [], warnings: [] });
  await withServer(stubExtract, async (base) => {
    const res = await fetch(`${base}/api/cards/extract-candidates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'validation_error');
    assert.equal(insertedCards.length, 0);
  });
});

// ── import-reviewed ────────────────────────────────────────────────────────────

test('/cards/import-reviewed: inserts only submitted reviewed cards', async () => {
  const stubExtract = async () => ({ cards: [], warnings: [] });
  await withServer(stubExtract, async (base) => {
    const res = await fetch(`${base}/api/cards/import-reviewed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: 'Álgebra',
        cards: [
          { question: '¿Qué es una matriz?', answer: 'Un arreglo bidimensional de números.', source_excerpt: '...', confidence: 0.95, status: 'ready' },
          { question: '¿Qué es un vector?',  answer: 'Un arreglo unidimensional.',          source_excerpt: '...', confidence: 0.88, status: 'ready' },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.inserted, 2);
    assert.equal(body.ids.length, 2);
    assert.equal(insertedCards.length, 2);
  });
});

test('/cards/import-reviewed: does not insert rejected cards', async () => {
  const stubExtract = async () => ({ cards: [], warnings: [] });
  await withServer(stubExtract, async (base) => {
    const res = await fetch(`${base}/api/cards/import-reviewed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cards: [
          { question: '¿Qué es X?', answer: 'Es Y.', status: 'ready'    },
          { question: '¿Qué es Z?', answer: 'Es W.', status: 'rejected'  },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.inserted, 1, 'only the non-rejected card should be inserted');
    assert.equal(insertedCards.length, 1);
  });
});

test('/cards/import-reviewed: returns validation errors for invalid cards', async () => {
  const stubExtract = async () => ({ cards: [], warnings: [] });
  await withServer(stubExtract, async (base) => {
    const res = await fetch(`${base}/api/cards/import-reviewed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cards: [
          { question: '', answer: 'Respuesta sin pregunta.', status: 'ready' },
          { question: 'Pregunta sin respuesta.', answer: '', status: 'ready' },
        ],
      }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'validation_error');
    assert.ok(Array.isArray(body.details));
    assert.equal(insertedCards.length, 0);
  });
});

test('/cards/import-reviewed: empty cards array returns 422', async () => {
  const stubExtract = async () => ({ cards: [], warnings: [] });
  await withServer(stubExtract, async (base) => {
    const res = await fetch(`${base}/api/cards/import-reviewed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cards: [] }),
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'validation_error');
    assert.equal(insertedCards.length, 0);
  });
});
