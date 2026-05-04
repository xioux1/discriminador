import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import schedulerRouter from '../scheduler.js';
import { dbPool } from '../../db/client.js';

const originalQuery = dbPool.query;

afterEach(() => {
  dbPool.query = originalQuery;
});

async function withServer(runTest) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 1 };
    next();
  });
  app.use(schedulerRouter);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await runTest(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

test('/scheduler/session mode=voice filtra por card_type theoretical_open', async () => {
  dbPool.query = async (sql) => {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (compact.includes('FROM micro_cards mc')) return { rows: [] };
    if (compact.includes('FROM cards c')) {
      if (compact.includes("c.card_type = 'theoretical_open'")) {
        return { rows: [{ id: 1, prompt_text: '¿Qué es la inercia?', expected_answer_text: '...', card_type: 'theoretical_open', review_count: 0, pass_count: 0 }], rowCount: 1 };
      }
      return { rows: [
        { id: 1, prompt_text: '¿Qué es la inercia?', expected_answer_text: '...', card_type: 'theoretical_open', review_count: 0, pass_count: 0 },
        { id: 2, prompt_text: 'Resuelva x^2=4', expected_answer_text: '...', card_type: 'practical_exercise', review_count: 0, pass_count: 0 },
      ], rowCount: 2 };
    }
    return { rows: [], rowCount: 0 };
  };

  await withServer(async (base) => {
    const normalRes = await fetch(`${base}/scheduler/session`);
    assert.equal(normalRes.status, 200);
    const normalBody = await normalRes.json();
    assert.equal(normalBody.cards.length, 2);

    const voiceRes = await fetch(`${base}/scheduler/session?mode=voice`);
    assert.equal(voiceRes.status, 200);
    const voiceBody = await voiceRes.json();
    assert.equal(voiceBody.cards.length, 1);
    assert.equal(voiceBody.cards[0].card_type, 'theoretical_open');
  });
});

