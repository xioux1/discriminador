import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import socraticRouter from '../socratic.js';

async function withServer(runTest) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1 };
    next();
  });
  app.use(socraticRouter);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    await runTest(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

function withLLMDisabled(fn) {
  return async (...args) => {
    const prev = process.env.ENABLE_LLM_JUDGE;
    process.env.ENABLE_LLM_JUDGE = 'false';
    try {
      await fn(...args);
    } finally {
      if (prev === undefined) delete process.env.ENABLE_LLM_JUDGE;
      else process.env.ENABLE_LLM_JUDGE = prev;
    }
  };
}

const VALID_QA = [
  { question: '¿Qué hace un cursor?', answer: 'Recorre filas de un SELECT.' }
];

// ── /socratic/questions ────────────────────────────────────────────────────────

test('/socratic/questions: returns 503 when LLM judge is disabled', withLLMDisabled(async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/socratic/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt_text: '¿Qué es un cursor?',
        user_answer_text: 'Es algo en la base de datos.',
        expected_answer_text: 'Un cursor recorre filas de un SELECT.',
        dimensions: { core_idea: 0.3 }
      })
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'service_unavailable');
  });
}));

test('/socratic/questions: rejects missing required fields', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/socratic/questions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt_text: '¿Qué es un cursor?' })
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'validation_error');
  });
});

// ── /socratic/evaluate ─────────────────────────────────────────────────────────

test('/socratic/evaluate: returns 503 when LLM judge is disabled', withLLMDisabled(async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/socratic/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt_text: '¿Qué es un cursor?',
        user_answer_text: 'Es algo en la base.',
        expected_answer_text: 'Un cursor recorre filas.',
        socratic_qa: VALID_QA
      })
    });
    assert.equal(res.status, 503);
  });
}));

test('/socratic/evaluate: rejects empty socratic_qa array', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/socratic/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt_text: '¿Qué es un cursor?',
        user_answer_text: 'Es algo.',
        expected_answer_text: 'Un cursor recorre filas.',
        socratic_qa: []
      })
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'validation_error');
  });
});

test('/socratic/evaluate: rejects socratic_qa item with short answer', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/socratic/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt_text: '¿Qué es un cursor?',
        user_answer_text: 'Es algo.',
        expected_answer_text: 'Un cursor recorre filas.',
        socratic_qa: [{ question: '¿Qué hace?', answer: 'No' }]
      })
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'validation_error');
  });
});

test('/socratic/evaluate: rejects missing core text fields', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/socratic/evaluate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ socratic_qa: VALID_QA })
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'validation_error');
  });
});

// ── /socratic/feedback ─────────────────────────────────────────────────────────

test('/socratic/feedback: returns 503 when LLM judge is disabled', withLLMDisabled(async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/socratic/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        prompt_text: '¿Qué es un cursor?',
        user_answer_text: 'Es algo.',
        expected_answer_text: 'Un cursor recorre filas.',
        socratic_qa: VALID_QA
      })
    });
    assert.equal(res.status, 503);
  });
}));

test('/socratic/feedback: rejects missing required fields', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/socratic/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ socratic_qa: VALID_QA })
    });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.error, 'validation_error');
  });
});
