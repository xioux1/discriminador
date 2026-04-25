import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import evaluateRouter from '../evaluate.js';
import { dbPool } from '../../db/client.js';

const originalConnect = dbPool.connect;
const originalQuery   = dbPool.query;

afterEach(() => {
  dbPool.connect = originalConnect;
  dbPool.query   = originalQuery;
});

function installEvalDbMock() {
  let nextId = 1;

  dbPool.query = async (sql) => {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (compact.startsWith('SELECT grading_strictness')) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };

  dbPool.connect = async () => ({
    async query(sql) {
      const compact = sql.replace(/\s+/g, ' ').trim();
      if (compact === 'BEGIN' || compact === 'COMMIT' || compact === 'ROLLBACK') return { rows: [], rowCount: 0 };
      if (compact.startsWith('SAVEPOINT') || compact.startsWith('RELEASE SAVEPOINT') || compact.startsWith('ROLLBACK TO SAVEPOINT')) return { rows: [], rowCount: 0 };
      if (compact.startsWith('INSERT INTO evaluation_items')) {
        return { rows: [{ id: nextId++, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }], rowCount: 1 };
      }
      if (compact.startsWith('INSERT INTO grade_suggestions')) {
        return { rows: [{ id: nextId++, created_at: new Date().toISOString() }], rowCount: 1 };
      }
      if (compact.startsWith('INSERT INTO evaluation_signals')) {
        return { rows: [{ id: nextId++, created_at: new Date().toISOString() }], rowCount: 1 };
      }
      if (compact.startsWith('INSERT INTO concept_gaps')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {}
  });
}

async function withServer(runTest) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1 };
    next();
  });
  app.use(evaluateRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    await runTest(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

const VALID_PAYLOAD = {
  prompt_text: '¿Qué es un cursor en PL/SQL?',
  user_answer_text: 'Un cursor es un puntero que recorre filas de un resultado SELECT.',
  expected_answer_text: 'Un cursor es un objeto que permite recorrer fila a fila el resultado de una consulta SELECT en PL/SQL.'
};

// ── Validation tests (no DB needed) ───────────────────────────────────────────

test('/evaluate: rejects non-JSON Content-Type', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'hello'
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'bad_request');
  });
});

test('/evaluate: rejects missing required fields', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt_text: '¿Qué es un cursor?' })
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'validation_error');
    const fields = body.details.map((d) => d.field);
    assert.ok(fields.includes('user_answer_text'));
    assert.ok(fields.includes('expected_answer_text'));
  });
});

test('/evaluate: rejects field exceeding maxLength', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...VALID_PAYLOAD,
        prompt_text: 'x'.repeat(2001)
      })
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'validation_error');
    const promptErr = body.details.find((d) => d.field === 'prompt_text');
    assert.ok(promptErr, 'should report prompt_text error');
  });
});

test('/evaluate: rejects non-string field type', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...VALID_PAYLOAD, prompt_text: 42 })
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error, 'bad_request');
  });
});

test('/evaluate: rejects invalid subject length', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...VALID_PAYLOAD, subject: 'x'.repeat(61) })
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'validation_error');
    const subjectErr = body.details.find((d) => d.field === 'subject');
    assert.ok(subjectErr);
  });
});

// ── Happy path test (with DB mock) ────────────────────────────────────────────

test('/evaluate: returns 200 with heuristic result when LLM judge is disabled', async () => {
  installEvalDbMock();
  const prev = process.env.ENABLE_LLM_JUDGE;
  process.env.ENABLE_LLM_JUDGE = 'false';

  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(VALID_PAYLOAD)
      });

      assert.equal(res.status, 200);
      const body = await res.json();

      assert.ok(body.evaluation_id, 'should include evaluation_id');
      assert.ok(typeof body.overall_score === 'number', 'should include overall_score');
      assert.ok(['again', 'hard', 'good', 'easy', 'pass', 'fail', 'review'].includes(body.suggested_grade?.toLowerCase()), 'should include valid suggested_grade');
      assert.equal(body.llm_fallback, false);
    });
  } finally {
    if (prev === undefined) delete process.env.ENABLE_LLM_JUDGE;
    else process.env.ENABLE_LLM_JUDGE = prev;
  }
});

test('/evaluate: persists subject when provided', async () => {
  installEvalDbMock();
  const prev = process.env.ENABLE_LLM_JUDGE;
  process.env.ENABLE_LLM_JUDGE = 'false';

  try {
    await withServer(async (base) => {
      const res = await fetch(`${base}/evaluate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...VALID_PAYLOAD, subject: 'bases-de-datos' })
      });

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.subject, 'bases-de-datos');
    });
  } finally {
    if (prev === undefined) delete process.env.ENABLE_LLM_JUDGE;
    else process.env.ENABLE_LLM_JUDGE = prev;
  }
});
