/**
 * SM-2 inspired interval calculator.
 * Binary pass/fail: no quality 0-5 scale, just success or failure.
 *
 * PASS: interval grows by ease_factor (compound spacing)
 * FAIL: reset to 1 day, ease degrades slightly (min 1.3)
 */
export function computeNextReview(intervalDays, easeFactor, grade) {
  if (grade === 'pass') {
    const newInterval = Math.max(1, Math.round(intervalDays * easeFactor));
    return {
      interval_days: newInterval,
      ease_factor: easeFactor,
      next_review_at: daysFromNow(newInterval)
    };
  }

  // fail
  return {
    interval_days: 1,
    ease_factor: Math.max(1.3, easeFactor - 0.2),
    next_review_at: daysFromNow(1)
  };
}

function daysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * A micro-card is considered mastered when its interval reaches 7+ days.
 * At that point it gets archived and stops appearing in sessions.
 */
export const MICRO_MASTERY_THRESHOLD_DAYS = 7;
