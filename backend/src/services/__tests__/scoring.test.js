import { test } from 'node:test';
import assert from 'node:assert/strict';

const payload = {
  evaluation_id: 'eval-1',
  prompt_text: 'Explica train_test_split en RN',
  subject: 'RN',
  expected_answer_text:
    'En RN se recomienda shuffle antes de separar y stratify para mantener proporción de clases.',
  user_answer_text:
    'Antes de separar conviene mezclar de forma aleatoria los datos y conservar la distribucion por clase.'
};

async function loadScoringModule(flagEnabled) {
  process.env.ENABLE_SEMANTIC_CORE_IDEA_RESCUE = flagEnabled ? 'true' : 'false';
  const modulePath = `../scoring.js?flag=${flagEnabled ? 'on' : 'off'}-${Date.now()}-${Math.random()}`;
  return import(modulePath);
}

test('detectCoreConcepts reconoce paráfrasis semánticas en RN', async () => {
  const { detectCoreConcepts } = await loadScoringModule(true);

  const result = detectCoreConcepts(payload);

  assert.equal(result.requiredConcepts, 2);
  assert.equal(result.matchedConcepts, 2);
  assert.equal(result.matched, true);
  assert.deepEqual(result.details, { shuffle: true, stratify: true });
});

test('sin feature flag, paráfrasis semántica puede quedar en core_idea = 0', async () => {
  const { scoreEvaluation } = await loadScoringModule(false);

  const result = scoreEvaluation(payload);

  assert.equal(result.dimensions.core_idea, 0);
  assert.equal(result.signals.detectedCoreConcepts.matched, true);
});

test('con feature flag, rescata core_idea a 0.5 cuando hay conceptos obligatorios', async () => {
  const { scoreEvaluation } = await loadScoringModule(true);

  const result = scoreEvaluation(payload);

  assert.equal(result.dimensions.core_idea, 0.5);
  assert.equal(result.signals.detectedCoreConcepts.matched, true);
});
