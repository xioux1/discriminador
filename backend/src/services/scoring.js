const ALLOWED_SCORES = [0.0, 0.5, 1.0];

const OVERALL_WEIGHTS = {
  core_idea: 0.35,
  conceptual_accuracy: 0.3,
  completeness: 0.25,
  memorization_risk: 0.1
};

const CONFIDENCE_BASE = 0.55;

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

function toDiscreteScore(value) {
  if (value >= 0.75) {
    return 1.0;
  }

  if (value >= 0.35) {
    return 0.5;
  }

  return 0.0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function overlapRatio(sourceTokens, targetTokens) {
  const sourceSet = new Set(sourceTokens);
  const targetSet = new Set(targetTokens);

  if (targetSet.size === 0) {
    return 0;
  }

  let intersection = 0;

  for (const token of targetSet) {
    if (sourceSet.has(token)) {
      intersection += 1;
    }
  }

  return intersection / targetSet.size;
}

function buildDimensions({ user_answer_text, expected_answer_text }) {
  const userTokens = tokenize(user_answer_text);
  const expectedTokens = tokenize(expected_answer_text);

  const keywordCoverage = overlapRatio(userTokens, expectedTokens);
  const answerLengthRatio = Math.min(user_answer_text.length / Math.max(expected_answer_text.length, 1), 1);
  const lexicalSimilarity = overlapRatio(userTokens, userTokens.length > expectedTokens.length ? userTokens : expectedTokens);

  const core_idea = toDiscreteScore(keywordCoverage);
  const conceptual_accuracy = toDiscreteScore(keywordCoverage * 0.8 + answerLengthRatio * 0.2);
  const completeness = toDiscreteScore(keywordCoverage * 0.7 + answerLengthRatio * 0.3);

  let memorization_risk = 1.0;

  if (lexicalSimilarity >= 0.85) {
    memorization_risk = 0.0;
  } else if (lexicalSimilarity >= 0.6) {
    memorization_risk = 0.5;
  }

  return {
    core_idea,
    conceptual_accuracy,
    completeness,
    memorization_risk
  };
}

function computeSuggestedGrade(dimensions) {
  const pass =
    dimensions.core_idea >= 0.5 &&
    dimensions.conceptual_accuracy >= 0.5 &&
    dimensions.completeness >= 0.5;

  return pass ? 'PASS' : 'FAIL';
}

function computeOverallScore(dimensions) {
  const weightedScore =
    dimensions.core_idea * OVERALL_WEIGHTS.core_idea +
    dimensions.conceptual_accuracy * OVERALL_WEIGHTS.conceptual_accuracy +
    dimensions.completeness * OVERALL_WEIGHTS.completeness +
    dimensions.memorization_risk * OVERALL_WEIGHTS.memorization_risk;

  return Number(weightedScore.toFixed(2));
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
  return `Fortaleza: ${strengthText(dimensions)}. Brecha: ${gapText(dimensions)}.`;
}

export function scoreEvaluation(payload) {
  const dimensions = buildDimensions(payload);

  for (const value of Object.values(dimensions)) {
    if (!ALLOWED_SCORES.includes(value)) {
      throw new Error('Invalid dimension score generated.');
    }
  }

  return {
    suggested_grade: computeSuggestedGrade(dimensions),
    overall_score: computeOverallScore(dimensions),
    dimensions,
    justification_short: buildJustification(dimensions),
    model_confidence: computeModelConfidence(dimensions)
  };
}
