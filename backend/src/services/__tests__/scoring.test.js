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

test('no otorga beneficio adicional por respuestas más largas cuando ya superan 50% del back', async () => {
  const { scoreEvaluation } = await loadScoringModule(true);

  const basePayload = {
    evaluation_id: 'eval-length-neutral',
    prompt_text: 'Explica train_test_split en RN',
    subject: 'RN',
    expected_answer_text:
      'shuffle estratificar separar datos entrenamiento prueba manteniendo proporcion de clases para evitar sesgo',
    user_answer_text:
      'shuffle estratificar separar datos entrenamiento prueba manteniendo proporcion de clases'
  };

  const longerPayload = {
    ...basePayload,
    evaluation_id: 'eval-length-neutral-long',
    user_answer_text: `${basePayload.user_answer_text} con observaciones adicionales de contexto operativo y ejemplos prácticos`
  };

  const baseResult = scoreEvaluation(basePayload);
  const longerResult = scoreEvaluation(longerPayload);

  assert.equal(baseResult.signals.answerLengthRatio > 0.5, true);
  assert.equal(longerResult.signals.answerLengthRatio > 0.5, true);
  assert.equal(baseResult.dimensions.conceptual_accuracy, longerResult.dimensions.conceptual_accuracy);
  assert.equal(baseResult.dimensions.completeness, longerResult.dimensions.completeness);
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

test('v2 aplica abreviaturas/correcciones conservadoras y expone replacements en signals', async () => {
  process.env.ENABLE_PREPROCESSING_V2 = 'true';
  const moduleWithPreprocessing = await import(`../scoring.js?corrections=${Date.now()}-${Math.random()}`);

  const correctedPayload = {
    evaluation_id: 'eval-corrections',
    prompt_text: 'Explica por qué RRHH registra datos.',
    subject: 'General',
    expected_answer_text: 'recursos humanos registra porque mejora la distribucion por clase',
    user_answer_text: 'rrhh registra xq mejora la distribuciom p/ clase'
  };

  const result = moduleWithPreprocessing.scoreEvaluation(correctedPayload);

  assert.equal(result.signals.replacements.user.rrhh, 'recursos humanos');
  assert.equal(result.signals.replacements.user.xq, 'porque');
  assert.equal(result.signals.replacements.user['p/'], 'para');
  assert.equal(result.signals.replacements.user.distribuciom, 'distribucion');
  assert.ok(result.signals.keywordCoverage >= 0.6);
});

test('v2 no falla cuando el token coincide con propiedades heredadas del objeto', async () => {
  process.env.ENABLE_PREPROCESSING_V2 = 'true';
  const moduleWithPreprocessing = await import(`../scoring.js?proto=${Date.now()}-${Math.random()}`);

  const payloadWithProtoToken = {
    evaluation_id: 'eval-proto-token',
    prompt_text: 'Explica __proto__ en JavaScript.',
    subject: 'General',
    expected_answer_text: 'proto javascript objeto',
    user_answer_text: '__proto__ javascript objeto'
  };

  assert.doesNotThrow(() => moduleWithPreprocessing.scoreEvaluation(payloadWithProtoToken));
});

test('rescata respuestas con typos densas en conceptos para evitar falso FAIL', async () => {
  const { scoreEvaluation } = await loadScoringModule(false);

  const typoDensePayload = {
    evaluation_id: 'eval-cicladas-typo-dense',
    prompt_text: 'puede caracterizarse en general el arte de las Islas Cícladas?',
    subject: '',
    expected_answer_text:
      'La civilización cicládica se desarrolló aproximadamente entre el 3000 y el 2000 a. C., en un contexto ligado a la pesca y al comercio. Su producción más característica son las figurillas talladas en mármol blanco. En ellas domina una fuerte síntesis formal: figuras femeninas sin rostro, con brazos pegados al cuerpo y anatomía reducida a lo esencial. Por eso, el rasgo central del arte cicládico es la geometrización y la abstracción, más que el detalle naturalista.',
    user_answer_text:
      'en las islas cicládicas consistía en estatuillas pequenas, que no podian apoyarse, no tenian apoyo, las misma tenian brazos pegados y una simplificacion muy alta, tambien geometrizacion alta. talladas en marmol blanco. la civilizacion se desarrollo entre 3000 y 2000 ac, pezca y comercio. rasgo central es gemotrizacion y abstraccion'
  };

  const result = scoreEvaluation(typoDensePayload);

  assert.notEqual(result.suggested_grade, 'FAIL');
  assert.equal(result.dimensions.core_idea, 0.5);
});
