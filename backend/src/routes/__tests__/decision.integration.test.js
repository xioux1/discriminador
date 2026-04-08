import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import decisionRouter from '../decision.js';
import { dbPool } from '../../db/client.js';

const originalConnect = dbPool.connect;
const originalQuery = dbPool.query;

afterEach(() => {
  dbPool.connect = originalConnect;
  dbPool.query = originalQuery;
});

function buildEvaluationStore() {
  return [
    {
      id: 101,
      user_id: 1,
      source_record_id: 'eval-user-1',
      prompt_text: 'Define inercia',
      user_answer_text: 'Es una fuerza',
      expected_answer_text: 'Resistencia al cambio de movimiento',
      subject: 'fisica',
      overall_score: 0.35,
      model_confidence: 0.81,
      suggested_grade: 'review'
    },
    {
      id: 202,
      user_id: 2,
      source_record_id: 'eval-user-2',
      prompt_text: 'Define inercia',
      user_answer_text: 'Es una fuerza',
      expected_answer_text: 'Resistencia al cambio de movimiento',
      subject: 'fisica',
      overall_score: 0.35,
      model_confidence: 0.81,
      suggested_grade: 'review'
    }
  ];
}

function installDbMock(records) {
  const inserted = [];

  dbPool.query = async () => ({ rows: [], rowCount: 0 });

  dbPool.connect = async () => ({
    async query(sql, params = []) {
      const compactSql = sql.replace(/\s+/g, ' ').trim();

      if (compactSql === 'BEGIN' || compactSql === 'COMMIT' || compactSql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      if (compactSql.startsWith('SELECT id FROM evaluation_items')) {
        const [evaluationId, userId] = params;
        const matched = records.find((record) => record.source_record_id === evaluationId && record.user_id === userId);
        return matched
          ? { rows: [{ id: matched.id }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }

      if (compactSql.startsWith('SELECT ei.id FROM evaluation_items ei')) {
        const [prompt, userAnswer, expectedAnswer, subject, overallScore, modelConfidence, suggestedGrade, confidence, userId] = params;

        const matched = records.find((record) => (
          record.prompt_text === prompt
          && record.user_answer_text === userAnswer
          && record.expected_answer_text === expectedAnswer
          && record.subject === subject
          && record.overall_score === overallScore
          && record.model_confidence === modelConfidence
          && record.suggested_grade === suggestedGrade
          && record.model_confidence === confidence
          && record.user_id === userId
        ));

        return matched
          ? { rows: [{ id: matched.id }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }

      if (compactSql.startsWith('INSERT INTO user_decisions')) {
        const [evaluationItemId, finalGrade, decisionType, reason] = params;
        const decision = {
          id: inserted.length + 1,
          evaluation_item_id: evaluationItemId,
          final_grade: finalGrade,
          decision_type: decisionType,
          reason,
          decided_at: '2026-01-01T00:00:00.000Z'
        };
        inserted.push(decision);
        return { rows: [decision], rowCount: 1 };
      }

      return { rows: [], rowCount: 0 };
    },
    release() {}
  });

  return { inserted };
}

async function withTestServer(runTest) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const headerUserId = req.headers['x-user-id'];
    req.user = headerUserId ? { id: Number(headerUserId) } : {};
    next();
  });
  app.use(decisionRouter);

  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  try {
    await runTest(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function buildPayload(overrides = {}) {
  return {
    action: 'uncertain',
    correction_reason: 'No estoy completamente seguro',
    accepted_suggestion: false,
    final_grade: 'fail',
    prompt_text: 'Define inercia',
    user_answer_text: 'Es una fuerza',
    expected_answer_text: 'Resistencia al cambio de movimiento',
    subject: 'fisica',
    evaluation_result: {
      overall_score: 0.35,
      model_confidence: 0.81,
      suggested_grade: 'REVIEW',
      dimensions: { exactitud: 0.35 }
    },
    ...overrides
  };
}

test('ruta /decision: dos usuarios con payload idéntico se aíslan por contexto', async () => {
  const records = buildEvaluationStore();
  installDbMock(records);

  await withTestServer(async (baseUrl) => {
    const payload = buildPayload();

    const responseUser1 = await fetch(`${baseUrl}/decision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': '1'
      },
      body: JSON.stringify(payload)
    });

    const responseUser2 = await fetch(`${baseUrl}/decision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': '2'
      },
      body: JSON.stringify(payload)
    });

    assert.equal(responseUser1.status, 201);
    assert.equal(responseUser2.status, 201);

    const body1 = await responseUser1.json();
    const body2 = await responseUser2.json();

    assert.equal(body1.decision.evaluation_item_id, 101);
    assert.equal(body2.decision.evaluation_item_id, 202);
  });
});

test('ruta /decision: resolución por evaluation_id respeta aislamiento por usuario', async () => {
  const records = buildEvaluationStore();
  installDbMock(records);

  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/decision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': '1'
      },
      body: JSON.stringify(buildPayload({ evaluation_id: 'eval-user-1' }))
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.decision.evaluation_item_id, 101);
    assert.equal(body.decision.evaluation_id, 'eval-user-1');
  });
});

test('ruta /decision: resolución por contexto usa misma política de aislamiento', async () => {
  const records = buildEvaluationStore();
  installDbMock(records);

  await withTestServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/decision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': '2'
      },
      body: JSON.stringify(buildPayload())
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.equal(body.decision.evaluation_item_id, 202);
  });
});

test('ruta /decision: cada usuario solo puede vincular su propio evaluation_item', async () => {
  const records = buildEvaluationStore();
  installDbMock(records);

  await withTestServer(async (baseUrl) => {
    const forbiddenLink = await fetch(`${baseUrl}/decision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': '1'
      },
      body: JSON.stringify(buildPayload({ evaluation_id: 'eval-user-2' }))
    });

    assert.equal(forbiddenLink.status, 422);
    const forbiddenBody = await forbiddenLink.json();
    assert.equal(forbiddenBody.error, 'validation_error');

    const missingUser = await fetch(`${baseUrl}/decision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(buildPayload({ evaluation_id: 'eval-user-1' }))
    });

    assert.equal(missingUser.status, 401);
    const missingUserBody = await missingUser.json();
    assert.equal(missingUserBody.error, 'unauthorized');
  });
});
