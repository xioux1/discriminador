import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import decisionRouter from '../decision.js';
import schedulerRouter from '../scheduler.js';
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
  app.use(schedulerRouter);

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

function installSchedulerFlowDbMock() {
  const state = {
    evaluationItems: [
      {
        id: 303,
        user_id: 1,
        source_record_id: 'eval-fail-303'
      }
    ],
    cards: [],
    microCards: [],
    conceptGaps: {
      303: [{ concept: 'inercia' }]
    },
    nextCardId: 1,
    nextMicroCardId: 1
  };

  dbPool.connect = async () => ({
    async query(sql, params = []) {
      const compactSql = sql.replace(/\s+/g, ' ').trim();

      if (compactSql === 'BEGIN' || compactSql === 'COMMIT' || compactSql === 'ROLLBACK') {
        return { rows: [], rowCount: 0 };
      }

      if (compactSql.startsWith('SELECT id FROM evaluation_items')) {
        const [evaluationId, userId] = params;
        const matched = state.evaluationItems.find((record) => (
          record.source_record_id === evaluationId && record.user_id === userId
        ));
        return matched ? { rows: [{ id: matched.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }

      if (compactSql.startsWith('INSERT INTO user_decisions')) {
        return {
          rows: [{
            id: 1,
            evaluation_item_id: params[0],
            final_grade: params[1],
            decision_type: params[2],
            reason: params[3],
            decided_at: '2026-01-01T00:00:00.000Z'
          }],
          rowCount: 1
        };
      }

      return { rows: [], rowCount: 0 };
    },
    release() {}
  });

  dbPool.query = async (sql, params = []) => {
    const compactSql = sql.replace(/\s+/g, ' ').trim();

    if (compactSql.startsWith('INSERT INTO activity_log')) {
      return { rows: [], rowCount: 1 };
    }

    if (compactSql.startsWith('SELECT mc.* FROM micro_cards mc WHERE mc.user_id = $1')) {
      const [userId, promptText, expectedAnswerText] = params;
      const found = state.microCards
        .filter((row) => row.user_id === userId && row.status === 'active'
          && row.question === promptText && row.expected_answer === expectedAnswerText)
        .sort((a, b) => b.id - a.id)[0];
      return found ? { rows: [found], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (compactSql.startsWith('SELECT * FROM cards WHERE user_id = $1')) {
      const [userId, promptText, expectedAnswerText] = params;
      const found = state.cards.find((card) => (
        card.user_id === userId
        && card.prompt_text === promptText
        && card.expected_answer_text === expectedAnswerText
        && card.archived_at === null
      ));
      return found ? { rows: [found], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (compactSql.startsWith('INSERT INTO cards (subject, prompt_text, expected_answer_text, user_id)')) {
      const [subject, promptText, expectedAnswerText, userId] = params;
      const card = {
        id: state.nextCardId++,
        subject,
        prompt_text: promptText,
        expected_answer_text: expectedAnswerText,
        user_id: userId,
        interval_days: 1,
        ease_factor: 2.5,
        next_review_at: new Date().toISOString(),
        review_count: 0,
        pass_count: 0,
        archived_at: null,
        suspended_at: null
      };
      state.cards.push(card);
      return { rows: [card], rowCount: 1 };
    }

    if (compactSql.startsWith('UPDATE cards SET interval_days = $1')) {
      const cardId = params[4];
      const card = state.cards.find((row) => row.id === cardId);
      if (card) {
        card.interval_days = params[0];
        card.ease_factor = params[1];
        card.next_review_at = params[2];
        card.review_count += 1;
        card.pass_count += params[3];
      }
      return { rows: [], rowCount: card ? 1 : 0 };
    }

    if (compactSql.startsWith('UPDATE micro_cards SET status = \'archived\'')) {
      return { rows: [], rowCount: 0 };
    }

    if (compactSql.startsWith('SELECT concept FROM concept_gaps WHERE evaluation_item_id = $1')) {
      const [evaluationItemId] = params;
      const rows = state.conceptGaps[evaluationItemId] ?? [];
      return { rows, rowCount: rows.length };
    }

    if (compactSql.startsWith('SELECT id FROM micro_cards WHERE parent_card_id = $1')) {
      const [parentCardId, concept] = params;
      const found = state.microCards.find((row) => (
        row.parent_card_id === parentCardId && row.concept === concept && row.status === 'active'
      ));
      return found ? { rows: [{ id: found.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }

    if (compactSql.startsWith('INSERT INTO micro_cards (parent_card_id, concept, question, expected_answer, user_id)')) {
      const [parentCardId, concept, question, expectedAnswer, userId] = params;
      const row = {
        id: state.nextMicroCardId++,
        parent_card_id: parentCardId,
        concept,
        question,
        expected_answer: expectedAnswer,
        user_id: userId,
        status: 'active',
        next_review_at: new Date(Date.now() - 1000).toISOString()
      };
      state.microCards.push(row);
      return { rows: [row], rowCount: 1 };
    }

    if (compactSql.startsWith('SELECT mc.*, c.subject AS parent_subject')) {
      const [userId] = params;
      const now = Date.now();
      const rows = state.microCards
        .filter((mc) => mc.user_id === userId && mc.status === 'active' && new Date(mc.next_review_at).getTime() <= now)
        .map((mc) => {
          const card = state.cards.find((c) => c.id === mc.parent_card_id);
          return {
            ...mc,
            parent_subject: card?.subject ?? null,
            parent_prompt: card?.prompt_text ?? null,
            parent_expected: card?.expected_answer_text ?? null
          };
        });
      return { rows, rowCount: rows.length };
    }

    if (compactSql.startsWith('SELECT c.*, COUNT(mc.id) FILTER (WHERE mc.status = \'active\') AS active_micro_count')) {
      return { rows: [], rowCount: 0 };
    }

    if (compactSql.startsWith('SELECT * FROM card_variants WHERE card_id = $1')) {
      return { rows: [], rowCount: 0 };
    }

    return { rows: [], rowCount: 0 };
  };

  return state;
}

test('ruta /decision FAIL con concept gaps crea micro-card con user_id y aparece en /scheduler/session', async () => {
  const state = installSchedulerFlowDbMock();

  await withTestServer(async (baseUrl) => {
    const decisionResponse = await fetch(`${baseUrl}/decision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': '1'
      },
      body: JSON.stringify(buildPayload({
        action: 'correct-fail',
        accepted_suggestion: false,
        correction_reason: 'La respuesta fue incorrecta',
        final_grade: 'fail',
        evaluation_id: 'eval-fail-303',
        evaluation_result: {
          overall_score: 0.2,
          model_confidence: 0.9,
          suggested_grade: 'FAIL',
          dimensions: { exactitud: 0.2 }
        }
      }))
    });

    assert.equal(decisionResponse.status, 201);

    for (let i = 0; i < 20 && state.microCards.length === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(state.microCards.length, 1);
    assert.equal(state.microCards[0].user_id, 1);

    const sessionResponse = await fetch(`${baseUrl}/scheduler/session`, {
      headers: {
        'x-user-id': '1'
      }
    });

    assert.equal(sessionResponse.status, 200);
    const sessionBody = await sessionResponse.json();

    assert.equal(sessionBody.micro_cards.length, 1);
    assert.equal(sessionBody.micro_cards[0].user_id, 1);
  });
});

test('ruta /decision corregida a PASS no crea micro-cards nuevas', async () => {
  const state = installSchedulerFlowDbMock();

  await withTestServer(async (baseUrl) => {
    const decisionResponse = await fetch(`${baseUrl}/decision`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-user-id': '1'
      },
      body: JSON.stringify(buildPayload({
        action: 'correct-pass',
        accepted_suggestion: false,
        correction_reason: 'La respuesta es suficiente',
        final_grade: 'pass',
        evaluation_id: 'eval-fail-303',
        evaluation_result: {
          overall_score: 0.2,
          model_confidence: 0.9,
          suggested_grade: 'FAIL',
          dimensions: { exactitud: 0.2 }
        }
      }))
    });

    assert.equal(decisionResponse.status, 201);

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(state.microCards.length, 0);
  });
});
