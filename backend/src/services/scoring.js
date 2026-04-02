import {
  isExperimentalOverallCoreOnlyEnabled,
  isPreprocessingV2Enabled,
  isSemanticCoreIdeaRescueEnabled
} from '../config/env.js';

const ALLOWED_SCORES = [0.0, 0.5, 1.0];

const OVERALL_WEIGHTS = {
  core_idea: 0.35,
  conceptual_accuracy: 0.3,
  completeness: 0.25,
  memorization_risk: 0.1
};
const CORE_DIMENSION_WEIGHT_SUM =
  OVERALL_WEIGHTS.core_idea + OVERALL_WEIGHTS.conceptual_accuracy + OVERALL_WEIGHTS.completeness;

const CONFIDENCE_BASE = 0.55;

const AUDITED_KEYWORD_COVERAGE_SAMPLE = [
  { human_grade: 'PASS', keywordCoverage: 0.82 },
  { human_grade: 'PASS', keywordCoverage: 0.77 },
  { human_grade: 'PASS', keywordCoverage: 0.73 },
  { human_grade: 'PASS', keywordCoverage: 0.69 },
  { human_grade: 'PASS', keywordCoverage: 0.64 },
  { human_grade: 'PASS', keywordCoverage: 0.61 },
  { human_grade: 'PASS', keywordCoverage: 0.58 },
  { human_grade: 'PASS', keywordCoverage: 0.53 },
  { human_grade: 'FAIL', keywordCoverage: 0.49 },
  { human_grade: 'FAIL', keywordCoverage: 0.44 },
  { human_grade: 'FAIL', keywordCoverage: 0.39 },
  { human_grade: 'FAIL', keywordCoverage: 0.33 },
  { human_grade: 'FAIL', keywordCoverage: 0.28 },
  { human_grade: 'FAIL', keywordCoverage: 0.21 },
  { human_grade: 'FAIL', keywordCoverage: 0.16 },
  { human_grade: 'FAIL', keywordCoverage: 0.11 }
];

const CORE_CONCEPT_SYNONYMS = {
  rn: {
    shuffle: [
      'shuffle',
      'mezclar',
      'aleatorizar',
      'aleatorio',
      'reordenar',
      'reordenamiento'
    ],
    stratify: [
      'stratify',
      'estratificar',
      'estratificado',
      'mantener proporcion',
      'mantener distribucion',
      'misma proporcion',
      'proporcion por clase',
      'distribucion por clase',
      'balance por clase'
    ]
  }
};

function normalizeText(text) {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function tokenize(text) {
  return normalizeText(text)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function normalizeTextV2(text) {
  return String(text || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function foldAccents(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

function tokenizeV2(text) {
  return normalizeTextV2(text)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/[.,;:!?"'()[\]{}¿¡]/g, ' ')
    .replace(/[-/]/g, ' ')
    .replace(/(\d),(\d)/g, '$1.$2')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function lemmatizeToken(token) {
  if (!token) return token;
  const foldedToken = foldAccents(token);

  const irregular = {
    datos: 'dato',
    clases: 'clase',
    conjuntos: 'conjunto',
    distribuciones: 'distribucion'
  };

  if (irregular[foldedToken]) return irregular[foldedToken];
  if (foldedToken.length > 5 && foldedToken.endsWith('ciones')) return `${foldedToken.slice(0, -6)}cion`;
  if (foldedToken.length > 5 && foldedToken.endsWith('es')) return foldedToken.slice(0, -2);
  if (foldedToken.length > 4 && foldedToken.endsWith('s')) return foldedToken.slice(0, -1);
  return foldedToken;
}

function lemmatizeTokens(tokens) {
  return tokens.map((token) => lemmatizeToken(token));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function percentile(sortedValues, ratio) {
  if (sortedValues.length === 0) {
    return 0;
  }

  if (sortedValues.length === 1) {
    return sortedValues[0];
  }

  const index = (sortedValues.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = index - lower;
  return sortedValues[lower] + (sortedValues[upper] - sortedValues[lower]) * weight;
}

function computeKeywordCoverageDistribution(sample) {
  const grouped = { PASS: [], FAIL: [] };

  for (const row of sample) {
    const humanGrade = String(row.human_grade || '').toUpperCase();
    const keywordCoverage = Number(row.keywordCoverage);
    if ((humanGrade === 'PASS' || humanGrade === 'FAIL') && Number.isFinite(keywordCoverage)) {
      grouped[humanGrade].push(keywordCoverage);
    }
  }

  for (const grade of ['PASS', 'FAIL']) {
    grouped[grade].sort((a, b) => a - b);
  }

  return {
    PASS: {
      count: grouped.PASS.length,
      p25: percentile(grouped.PASS, 0.25),
      p50: percentile(grouped.PASS, 0.5),
      p75: percentile(grouped.PASS, 0.75)
    },
    FAIL: {
      count: grouped.FAIL.length,
      p25: percentile(grouped.FAIL, 0.25),
      p50: percentile(grouped.FAIL, 0.5),
      p75: percentile(grouped.FAIL, 0.75)
    }
  };
}

function deriveBaseThresholds(distribution) {
  const mid = clamp((distribution.PASS.p25 + distribution.FAIL.p75) / 2, 0.2, 0.65);
  const high = clamp(distribution.PASS.p50, mid + 0.05, 0.95);

  return {
    mid: Number(mid.toFixed(3)),
    high: Number(high.toFixed(3))
  };
}

const KEYWORD_COVERAGE_DISTRIBUTION = computeKeywordCoverageDistribution(AUDITED_KEYWORD_COVERAGE_SAMPLE);
const BASE_THRESHOLDS = deriveBaseThresholds(KEYWORD_COVERAGE_DISTRIBUTION);

const DIMENSION_THRESHOLDS = {
  core_idea: {
    mid: BASE_THRESHOLDS.mid,
    high: BASE_THRESHOLDS.high
  },
  conceptual_accuracy: {
    mid: Number(clamp(BASE_THRESHOLDS.mid + 0.04, 0.2, 0.85).toFixed(3)),
    high: Number(clamp(BASE_THRESHOLDS.high - 0.03, 0.3, 0.95).toFixed(3))
  },
  completeness: {
    mid: Number(clamp(BASE_THRESHOLDS.mid + 0.08, 0.2, 0.9).toFixed(3)),
    high: Number(clamp(BASE_THRESHOLDS.high - 0.07, 0.3, 0.95).toFixed(3))
  }
};

function toDiscreteScore(value, dimension = 'core_idea') {
  const thresholds = DIMENSION_THRESHOLDS[dimension] || DIMENSION_THRESHOLDS.core_idea;

  if (value >= thresholds.high) {
    return 1.0;
  }

  if (value >= thresholds.mid) {
    return 0.5;
  }

  return 0.0;
}

function canonicalToken(token) {
  return foldAccents(String(token || '').toLowerCase()).replace(/[^a-z0-9]/g, '');
}

function boundedLevenshteinDistance(a, b, maxDistance = 1) {
  if (a === b) return 0;
  if (!a || !b) return Math.max(a.length, b.length);
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;

  let previous = new Array(b.length + 1);
  let current = new Array(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let minInRow = current[0];

    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + substitutionCost
      );
      current[j] = value;
      if (value < minInRow) minInRow = value;
    }

    if (minInRow > maxDistance) {
      return maxDistance + 1;
    }

    [previous, current] = [current, previous];
  }

  return previous[b.length];
}

function overlapRatio(sourceTokens, targetTokens, options = {}) {
  const sourceCanonical = sourceTokens.map((token) => canonicalToken(token)).filter(Boolean);
  const targetCanonical = targetTokens.map((token) => canonicalToken(token)).filter(Boolean);
  const sourceSet = new Set(sourceCanonical);
  const targetSet = new Set(targetCanonical);

  if (targetSet.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const token of targetSet) {
    if (sourceSet.has(token)) {
      intersection += 1;
      continue;
    }

    if (options.enableTypoTolerance && token.length >= 5) {
      const hasCloseMatch = sourceCanonical.some(
        (sourceToken) =>
          sourceToken.length >= 5 && boundedLevenshteinDistance(sourceToken, token, 1) <= 1
      );

      if (hasCloseMatch) {
        intersection += 1;
      }
    }
  }

  return intersection / targetSet.size;
}

function containsAnyExpression(text, expressions) {
  return expressions.some((expression) => text.includes(expression));
}

function buildPreprocessingOutput({ user_answer_text, expected_answer_text }, variant) {
  if (variant === 'v2') {
    const userTokens = tokenizeV2(user_answer_text);
    const expectedTokens = tokenizeV2(expected_answer_text);
    return {
      variant,
      user: {
        normalizedText: normalizeTextV2(user_answer_text),
        tokens: userTokens,
        lemmas: lemmatizeTokens(userTokens)
      },
      expected: {
        normalizedText: normalizeTextV2(expected_answer_text),
        tokens: expectedTokens,
        lemmas: lemmatizeTokens(expectedTokens)
      }
    };
  }

  const userTokens = tokenize(user_answer_text);
  const expectedTokens = tokenize(expected_answer_text);
  return {
    variant: 'legacy',
    user: {
      normalizedText: normalizeText(user_answer_text || ''),
      tokens: userTokens,
      lemmas: userTokens
    },
    expected: {
      normalizedText: normalizeText(expected_answer_text || ''),
      tokens: expectedTokens,
      lemmas: expectedTokens
    }
  };
}

export function detectCoreConcepts({ user_answer_text, expected_answer_text, subject }) {
  const normalizedUser = normalizeText(user_answer_text || '');
  const normalizedExpected = normalizeText(expected_answer_text || '');
  const conceptMap = CORE_CONCEPT_SYNONYMS[(subject || '').toLowerCase()];

  if (!conceptMap) {
    return { matched: false, requiredConcepts: 0, matchedConcepts: 0, details: {} };
  }

  const requiredConcepts = Object.entries(conceptMap)
    .filter(([, expressions]) => containsAnyExpression(normalizedExpected, expressions))
    .map(([concept]) => concept);

  if (requiredConcepts.length === 0) {
    return { matched: false, requiredConcepts: 0, matchedConcepts: 0, details: {} };
  }

  const details = {};
  let matchedConcepts = 0;

  for (const concept of requiredConcepts) {
    const expressions = conceptMap[concept];
    const conceptMatched = containsAnyExpression(normalizedUser, expressions);
    details[concept] = conceptMatched;

    if (conceptMatched) {
      matchedConcepts += 1;
    }
  }

  return {
    matched: matchedConcepts === requiredConcepts.length,
    requiredConcepts: requiredConcepts.length,
    matchedConcepts,
    details
  };
}

function buildDimensions({
  user_answer_text,
  expected_answer_text,
  evaluation_id,
  prompt_text,
  subject,
  preprocessingOutput
}) {
  const userTokens = preprocessingOutput.user.lemmas;
  const expectedTokens = preprocessingOutput.expected.lemmas;
  const typoToleranceEnabled = preprocessingOutput.variant === 'v2';

  const keywordCoverage = overlapRatio(userTokens, expectedTokens, {
    enableTypoTolerance: typoToleranceEnabled
  });
  const answerLengthRatio = Math.min(user_answer_text.length / Math.max(expected_answer_text.length, 1), 1);
  const lexicalSimilarity = overlapRatio(
    userTokens,
    userTokens.length > expectedTokens.length ? userTokens : expectedTokens,
    {
      enableTypoTolerance: typoToleranceEnabled
    }
  );
  const detectedCoreConcepts = detectCoreConcepts({ user_answer_text, expected_answer_text, subject });

  let core_idea = toDiscreteScore(keywordCoverage, 'core_idea');
  if (isSemanticCoreIdeaRescueEnabled() && core_idea < 0.5 && detectedCoreConcepts.matched) {
    core_idea = 0.5;
  }

  const conceptual_accuracy = toDiscreteScore(
    keywordCoverage * 0.8 + answerLengthRatio * 0.2,
    'conceptual_accuracy'
  );
  const completeness = toDiscreteScore(keywordCoverage * 0.7 + answerLengthRatio * 0.3, 'completeness');

  let memorization_risk = 1.0;

  if (lexicalSimilarity >= 0.85) {
    memorization_risk = 0.0;
  } else if (lexicalSimilarity >= 0.6) {
    memorization_risk = 0.5;
  }

  const dimensions = {
    core_idea,
    conceptual_accuracy,
    completeness,
    memorization_risk
  };

  console.info('buildDimensions signals', {
    evaluation_id,
    prompt_text,
    subject,
    preprocessingVariant: preprocessingOutput.variant,
    keywordCoverage,
    answerLengthRatio,
    lexicalSimilarity,
    detectedCoreConcepts,
    keywordCoverageDistribution: KEYWORD_COVERAGE_DISTRIBUTION,
    dimensionThresholds: DIMENSION_THRESHOLDS,
    dimensions
  });

  return {
    dimensions,
    keywordCoverage,
    answerLengthRatio,
    lexicalSimilarity,
    detectedCoreConcepts
  };
}

function runDualPathEvaluation(payload) {
  const legacyPreprocessing = buildPreprocessingOutput(payload, 'legacy');
  const v2Preprocessing = buildPreprocessingOutput(payload, 'v2');
  const useV2 = isPreprocessingV2Enabled();

  const legacy = buildDimensions({ ...payload, preprocessingOutput: legacyPreprocessing });
  const preprocessed = buildDimensions({ ...payload, preprocessingOutput: v2Preprocessing });

  return {
    selectedVariant: useV2 ? 'v2' : 'legacy',
    selected: useV2 ? preprocessed : legacy,
    legacy,
    preprocessed
  };
}

function computeSuggestedGrade(dimensions) {
  const criticalDimensions = [
    dimensions.core_idea,
    dimensions.conceptual_accuracy,
    dimensions.completeness
  ];
  const failingCriticalDimensions = criticalDimensions.filter((score) => score < 0.5);
  const pass = failingCriticalDimensions.length === 0;

  if (pass) {
    return 'PASS';
  }

  const smallMarginFailure =
    failingCriticalDimensions.length === 1 &&
    failingCriticalDimensions[0] === 0.0;

  if (smallMarginFailure) {
    return 'REVIEW';
  }

  return 'FAIL';
}

function computeOverallScoreIncludingMemorization(dimensions) {
  const weightedScore =
    dimensions.core_idea * OVERALL_WEIGHTS.core_idea +
    dimensions.conceptual_accuracy * OVERALL_WEIGHTS.conceptual_accuracy +
    dimensions.completeness * OVERALL_WEIGHTS.completeness +
    dimensions.memorization_risk * OVERALL_WEIGHTS.memorization_risk;

  return Number(weightedScore.toFixed(2));
}

function computeOverallScoreSubtractingMemorization(dimensions) {
  const weightedScore =
    dimensions.core_idea * OVERALL_WEIGHTS.core_idea +
    dimensions.conceptual_accuracy * OVERALL_WEIGHTS.conceptual_accuracy +
    dimensions.completeness * OVERALL_WEIGHTS.completeness -
    dimensions.memorization_risk * OVERALL_WEIGHTS.memorization_risk;

  return Number(clamp(weightedScore, 0, 1).toFixed(2));
}

function computeOverallScoreCoreOnly(dimensions) {
  const weightedCoreScore =
    dimensions.core_idea * OVERALL_WEIGHTS.core_idea +
    dimensions.conceptual_accuracy * OVERALL_WEIGHTS.conceptual_accuracy +
    dimensions.completeness * OVERALL_WEIGHTS.completeness;

  return Number((weightedCoreScore / CORE_DIMENSION_WEIGHT_SUM).toFixed(2));
}

export function computeOverallScoreVariants(dimensions) {
  return {
    include_memorization: computeOverallScoreIncludingMemorization(dimensions),
    subtract_memorization: computeOverallScoreSubtractingMemorization(dimensions),
    core_only_experimental: computeOverallScoreCoreOnly(dimensions)
  };
}

function computeModelConfidence(dimensions) {
  let confidence = CONFIDENCE_BASE;

  if (dimensions.core_idea === dimensions.conceptual_accuracy) {
    confidence += 0.15;
  }

  if (dimensions.completeness >= 0.5) {
    confidence += 0.1;
  }

  if (dimensions.core_idea === 1.0 && dimensions.conceptual_accuracy === 0.0) {
    confidence -= 0.2;
  }

  if (dimensions.memorization_risk === 0.0) {
    confidence -= 0.1;
  }

  return Number(clamp(confidence, 0.0, 1.0).toFixed(2));
}

function strengthText(dimensions) {
  if (dimensions.core_idea === 1.0) {
    return 'identifica correctamente la idea central';
  }

  if (dimensions.conceptual_accuracy >= 0.5) {
    return 'mantiene una precisión conceptual aceptable';
  }

  if (dimensions.completeness >= 0.5) {
    return 'incluye parte relevante de los elementos esperados';
  }

  return 'presenta una respuesta inicial al problema';
}

function gapText(dimensions) {
  if (dimensions.completeness < 0.5) {
    return 'falta cubrir puntos mínimos de la explicación';
  }

  if (dimensions.conceptual_accuracy < 0.5) {
    return 'hay errores conceptuales que deben corregirse';
  }

  if (dimensions.memorization_risk < 0.5) {
    return 'conviene reformular con más elaboración propia';
  }

  return 'puede profundizar con mayor detalle técnico';
}

function buildJustification(dimensions) {
  const memorizationSignal =
    dimensions.memorization_risk === 0.0
      ? 'alta dependencia de formulación textual del back'
      : dimensions.memorization_risk === 0.5
        ? 'riesgo intermedio de respuesta memorizada'
        : 'bajo riesgo de memorización literal';

  return `Fortaleza: ${strengthText(dimensions)}. Brecha: ${gapText(dimensions)}. Señal memorization_risk: ${memorizationSignal}.`;
}

export function getScoringCalibrationSnapshot() {
  return {
    keywordCoverageDistribution: KEYWORD_COVERAGE_DISTRIBUTION,
    dimensionThresholds: DIMENSION_THRESHOLDS
  };
}

export function scoreEvaluation(payload) {
  const evaluationPaths = runDualPathEvaluation(payload);
  const { dimensions, keywordCoverage, answerLengthRatio, lexicalSimilarity, detectedCoreConcepts } =
    evaluationPaths.selected;

  for (const value of Object.values(dimensions)) {
    if (!ALLOWED_SCORES.includes(value)) {
      throw new Error('Invalid dimension score generated.');
    }
  }

  const suggestedGrade = computeSuggestedGrade(dimensions);
  const overallScoreVariants = computeOverallScoreVariants(dimensions);
  const overallScore = isExperimentalOverallCoreOnlyEnabled()
    ? overallScoreVariants.core_only_experimental
    : overallScoreVariants.include_memorization;
  const result = {
    suggested_grade: suggestedGrade,
    overall_score: overallScore,
    dimensions,
    justification_short: buildJustification(dimensions),
    model_confidence: computeModelConfidence(dimensions),
    signals: {
      keywordCoverage,
      answerLengthRatio,
      lexicalSimilarity,
      detectedCoreConcepts,
      overallScoreVariants
    }
  };

  console.info('scoreEvaluation result', {
    evaluation_id: payload.evaluation_id,
    prompt_text: payload.prompt_text,
    subject: payload.subject,
    preprocessingVariant: evaluationPaths.selectedVariant,
    preprocessingComparison: {
      legacy: evaluationPaths.legacy.dimensions,
      preprocessed: evaluationPaths.preprocessed.dimensions
    },
    keywordCoverage,
    answerLengthRatio,
    lexicalSimilarity,
    detectedCoreConcepts,
    dimensionThresholds: DIMENSION_THRESHOLDS,
    dimensions,
    suggested_grade: suggestedGrade
  });

  return result;
}

export function scoreEvaluationOfflineComparison(payload) {
  const evaluationPaths = runDualPathEvaluation(payload);
  return {
    selected_variant: evaluationPaths.selectedVariant,
    selected: evaluationPaths.selected,
    legacy: evaluationPaths.legacy,
    preprocessed: evaluationPaths.preprocessed
  };
}
