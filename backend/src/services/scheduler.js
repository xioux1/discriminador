/**
 * FSRS-5 spaced repetition scheduler.
 *
 * again (1) – Blackout: sin respuesta, error conceptual grave
 * hard  (2) – Idea general correcta, pero faltan detalles críticos
 * good  (3) – Respuesta correcta con todos los conceptos esenciales
 * easy  (4) – Perfecto, inmediato, podría enseñarlo
 *
 * Backward compat: 'pass' → 'good', 'fail' → 'again'.
 */

// FSRS-5 default trained weights
const W = [
  0.4072, 1.1829, 3.1262, 15.4722, // w[0-3]: initial stability by grade 1,2,3,4
  7.2102, 0.5316,                   // w[4-5]: initial difficulty params
  1.0651, 0.0589,                   // w[6-7]: difficulty mean-reversion
  1.1473, 0.1441, 1.0150,           // w[8-10]: stability post-recall
  1.9275, 0.1100, 0.2900, 2.2700,  // w[11-14]: stability post-forget
  0.0857, 2.9898,                  // w[15-16]: hard penalty / easy bonus
  0.5100, 0.4370                   // w[17-18]: short-term (unused)
];

const DESIRED_RETENTION = 0.9;
const ARGENTINA_TZ = 'America/Argentina/Buenos_Aires';

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function gradeToInt(grade) {
  const map = { again: 1, hard: 2, good: 3, easy: 4 };
  return map[grade] || 3;
}

function initialStability(grade) {
  return W[gradeToInt(grade) - 1];
}

function initialDifficulty(grade) {
  const g = gradeToInt(grade);
  return clamp(W[4] - Math.exp(W[5] * (g - 1)) + 1, 1, 10);
}

function nextInterval(stability) {
  // For DESIRED_RETENTION=0.9: 9×S×(1/0.9−1) = S, so interval ≈ round(S)
  return Math.max(1, Math.round(9 * stability * (1 / DESIRED_RETENTION - 1)));
}

function elapsedDays(lastReviewedAt) {
  if (!lastReviewedAt) return 0;
  return Math.max(0, (Date.now() - new Date(lastReviewedAt).getTime()) / 86400000);
}

function retrievability(t, stability) {
  return Math.pow(1 + t / (9 * stability), -1);
}

function stabilityAfterRecall(D, S, R, G) {
  const hardPenalty = G === 2 ? W[15] : 1;
  const easyBonus   = G === 4 ? W[16] : 1;
  return Math.max(0.01, S * (
    Math.exp(W[8]) * (11 - D) * Math.pow(S, -W[9]) * (Math.exp((1 - R) * W[10]) - 1)
    * hardPenalty * easyBonus
    + 1
  ));
}

function stabilityAfterForget(D, S, R) {
  return Math.max(0.01, Math.min(S,
    W[11] * Math.pow(D, -W[12]) * (Math.pow(S + 1, W[13]) - 1) * Math.exp((1 - R) * W[14])
  ));
}

function updateDifficulty(D, G) {
  const D0good = initialDifficulty(3); // mean-reversion target ≈ 5.3
  return clamp(W[6] * D0good + (1 - W[6]) * (D - W[7] * (G - 3)), 1, 10);
}

/** Derive ease_factor from difficulty for backward compatibility. */
export function difficultyToEaseFactor(difficulty) {
  // Inverse of the backfill formula: difficulty = 10 - ((ease_factor - 1.3) / 1.7 * 9)
  return clamp((10 - difficulty) / 9 * 1.7 + 1.3, 1.3, 3.0);
}

/**
 * Compute FSRS-5 scheduling for the next review.
 *
 * @param {object} params
 * @param {number}           params.stability      Current stability (days). Ignored when isNew=true.
 * @param {number}           params.difficulty     Current difficulty [1,10]. Ignored when isNew=true.
 * @param {Date|string|null} params.lastReviewedAt Timestamp of last review.
 * @param {string}           params.grade          'again'|'hard'|'good'|'easy' (+ legacy 'pass'|'fail')
 * @param {boolean}          params.isNew          True when review_count === 0.
 * @returns {{ stability, difficulty, interval_days, ease_factor, next_review_at }}
 */
export function computeNextReview({ stability, difficulty, lastReviewedAt, grade, isNew }) {
  const g = grade === 'pass' ? 'good' : grade === 'fail' ? 'again' : (grade || 'good');
  const G = gradeToInt(g);

  let newStability, newDifficulty, intervalDays;

  if (isNew) {
    newStability  = initialStability(g);
    newDifficulty = initialDifficulty(g);
    intervalDays  = g === 'again' ? 1 : nextInterval(newStability);
  } else {
    const S = Math.max(0.01, parseFloat(stability) || 3.1262);
    const D = clamp(parseFloat(difficulty) || 5.0, 1, 10);
    const t = elapsedDays(lastReviewedAt);
    const R = retrievability(t, S);

    newDifficulty = updateDifficulty(D, G);

    if (g === 'again') {
      newStability = stabilityAfterForget(D, S, R);
      intervalDays = 1;
    } else {
      newStability = stabilityAfterRecall(D, S, R, G);
      intervalDays = nextInterval(newStability);
    }
  }

  return {
    stability:     newStability,
    difficulty:    newDifficulty,
    interval_days: intervalDays,
    ease_factor:   difficultyToEaseFactor(newDifficulty),
    next_review_at: daysFromNow(intervalDays)
  };
}

/** Returns true for grades that represent successful recall (good, easy, legacy pass). */
export function isPassGrade(grade) {
  return ['pass', 'good', 'easy'].includes(grade);
}

/** Returns true for grades that represent failed/partial recall (again, hard, legacy fail). */
export function isFailGrade(grade) {
  return ['fail', 'again', 'hard'].includes(grade);
}

function daysFromNow(days) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ARGENTINA_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  const midnightLocal = new Date(`${y}-${m}-${d}T00:00:00`);
  midnightLocal.setDate(midnightLocal.getDate() + days);
  return midnightLocal;
}
