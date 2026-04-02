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
  process.env.ENABLE_EXPERIMENTAL_OVERALL_CORE_ONLY = 'false';
  process.env.ENABLE_PREPROCESSING_V2 = 'false';
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

test('calibra umbrales por dimensión a partir de muestra auditada PASS/FAIL', async () => {
  const { getScoringCalibrationSnapshot } = await loadScoringModule(true);

  const snapshot = getScoringCalibrationSnapshot();

  assert.equal(snapshot.keywordCoverageDistribution.PASS.count, 8);
  assert.equal(snapshot.keywordCoverageDistribution.FAIL.count, 8);
  assert.ok(snapshot.keywordCoverageDistribution.PASS.p50 > snapshot.keywordCoverageDistribution.FAIL.p75);

  assert.notEqual(snapshot.dimensionThresholds.core_idea.mid, snapshot.dimensionThresholds.completeness.mid);
  assert.notEqual(snapshot.dimensionThresholds.core_idea.high, snapshot.dimensionThresholds.conceptual_accuracy.high);
});

test('regresión: cambios menores de wording no deben voltear core_idea de 0.5 a 0.0', async () => {
  const { scoreEvaluation } = await loadScoringModule(true);

  const basePayload = {
    evaluation_id: 'eval-wording-base',
    prompt_text: 'Explica train_test_split en RN',
    subject: 'RN',
    expected_answer_text:
      'En RN se recomienda shuffle antes de separar y stratify para mantener proporción de clases.',
    user_answer_text:
      'Se debe mezclar de forma aleatoria y mantener la distribucion por clase antes de separar conjuntos.'
  };

  const minorWordingChangePayload = {
    ...basePayload,
    evaluation_id: 'eval-wording-variant',
    user_answer_text:
      'Conviene mezclar aleatoriamente y conservar la distribucion por clase antes de separar los conjuntos.'
  };

  const baseResult = scoreEvaluation(basePayload);
  const variantResult = scoreEvaluation(minorWordingChangePayload);

  assert.equal(baseResult.dimensions.core_idea, 0.5);
  assert.notEqual(variantResult.dimensions.core_idea, 0.0);
});

test('sugiere REVIEW cuando falla solo una dimensión crítica por margen pequeño', async () => {
  const { scoreEvaluation } = await loadScoringModule(true);

  const reviewPayload = {
    evaluation_id: 'eval-review',
    prompt_text: 'Explica el flujo mínimo de evaluación.',
    subject: 'General',
    expected_answer_text:
      'analisis modelo evidencia contexto criterio respuesta validacion docente manual',
    user_answer_text:
      'analisis modelo evidencia contexto con comentarios adicionales para aportar trazabilidad'
  };

  const result = scoreEvaluation(reviewPayload);

  assert.equal(result.dimensions.core_idea, 0.0);
  assert.equal(result.dimensions.conceptual_accuracy, 0.5);
  assert.ok(result.dimensions.completeness >= 0.5);
  assert.equal(result.suggested_grade, 'REVIEW');
});

test('expone variantes de overall y permite modo experimental core-only', async () => {
  process.env.ENABLE_SEMANTIC_CORE_IDEA_RESCUE = 'true';
  process.env.ENABLE_EXPERIMENTAL_OVERALL_CORE_ONLY = 'false';
  const moduleBase = await import(`../scoring.js?overall=base-${Date.now()}-${Math.random()}`);
  const baseResult = moduleBase.scoreEvaluation(payload);
  const baseVariants = baseResult.signals.overallScoreVariants;

  assert.equal(baseResult.overall_score, baseVariants.include_memorization);
  assert.ok(typeof baseResult.justification_short === 'string');
  assert.ok(baseResult.justification_short.includes('Señal memorization_risk'));
  assert.ok(baseVariants.subtract_memorization <= baseVariants.include_memorization);
  assert.ok(baseVariants.core_only_experimental >= 0.0 && baseVariants.core_only_experimental <= 1.0);

  process.env.ENABLE_EXPERIMENTAL_OVERALL_CORE_ONLY = 'true';
  const moduleExperimental = await import(`../scoring.js?overall=exp-${Date.now()}-${Math.random()}`);
  const experimentalResult = moduleExperimental.scoreEvaluation(payload);

  assert.equal(
    experimentalResult.overall_score,
    experimentalResult.signals.overallScoreVariants.core_only_experimental
  );
});

test('mantiene doble ruta legacy/v2 disponible para evaluación offline', async () => {
  process.env.ENABLE_PREPROCESSING_V2 = 'true';
  const moduleWithPreprocessing = await import(`../scoring.js?preproc=${Date.now()}-${Math.random()}`);
  const comparison = moduleWithPreprocessing.scoreEvaluationOfflineComparison(payload);

  assert.equal(comparison.selected_variant, 'v2');
  assert.deepEqual(Object.keys(comparison.legacy.dimensions), Object.keys(comparison.preprocessed.dimensions));
});
