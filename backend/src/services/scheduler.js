/**
 * Extended SM-2 with 4 quality grades (FSRS-inspired).
 *
 * again (1) – Blackout completo: sin respuesta, error conceptual grave
 * hard  (2) – Idea general correcta, pero faltan detalles técnicos críticos
 * good  (3) – Respuesta correcta con todos los conceptos esenciales
 * easy  (4) – Perfecto, inmediato, podría enseñarlo
 *
 * Backward compat: 'pass' → 'good', 'fail' → 'again'.
 */
export function computeNextReview(intervalDays, easeFactor, grade) {
  // Normalize legacy grades
  const g = grade === 'pass' ? 'good' : grade === 'fail' ? 'again' : grade;

  switch (g) {
    case 'again':
      // Full reset: 1 day, significant ease penalty
      return {
        interval_days: 1,
        ease_factor: Math.max(1.3, easeFactor - 0.30),
        next_review_at: daysFromNow(1)
      };

    case 'hard': {
      // Partial reset: interval shrinks to 80%, small ease penalty
      const newInterval = Math.max(1, Math.floor(intervalDays * 0.8));
      return {
        interval_days: newInterval,
        ease_factor: Math.max(1.3, easeFactor - 0.15),
        next_review_at: daysFromNow(newInterval)
      };
    }

    case 'good': {
      // Standard spacing: interval grows by ease_factor
      const newInterval = Math.max(1, Math.round(intervalDays * easeFactor));
      return {
        interval_days: newInterval,
        ease_factor: easeFactor,
        next_review_at: daysFromNow(newInterval)
      };
    }

    case 'easy': {
      // Boosted spacing: grows faster, ease improves
      const newInterval = Math.max(1, Math.round(intervalDays * easeFactor * 1.3));
      return {
        interval_days: newInterval,
        ease_factor: Math.min(3.0, easeFactor + 0.10),
        next_review_at: daysFromNow(newInterval)
      };
    }

    default:
      // Fallback: treat as 'good'
      return {
        interval_days: Math.max(1, Math.round(intervalDays * easeFactor)),
        ease_factor: easeFactor,
        next_review_at: daysFromNow(Math.max(1, Math.round(intervalDays * easeFactor)))
      };
  }
}

/** Returns true for grades that represent successful recall (good, easy, legacy pass). */
export function isPassGrade(grade) {
  return ['pass', 'good', 'easy'].includes(grade);
}

/** Returns true for grades that represent failed/partial recall (again, hard, legacy fail). */
export function isFailGrade(grade) {
  return ['fail', 'again', 'hard'].includes(grade);
}

const ARGENTINA_TZ = 'America/Argentina/Buenos_Aires';

function daysFromNow(days) {
  // Compute today's local date in Argentina timezone using Intl API (handles DST correctly).
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: ARGENTINA_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  const d = parts.find((p) => p.type === 'day').value;
  // Midnight in Argentina = ISO date string at local midnight, interpreted as UTC offset target.
  const midnightLocal = new Date(`${y}-${m}-${d}T00:00:00`);
  midnightLocal.setDate(midnightLocal.getDate() + days);
  return midnightLocal;
}
