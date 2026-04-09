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
  // Anki-style: next_review_at = midnight of (today + days) in Argentina time.
  // Cards become due at 00:00 local time, not at the exact hour of the review,
  // so the full day's queue is available at midnight rather than dripping in
  // throughout the day as timestamps from N days ago are crossed.
  //
  // Argentina = UTC-3 (no DST). Midnight Argentina = 03:00 UTC.
  const BUE_MS = 3 * 60 * 60 * 1000; // 3-hour offset
  // Shift to Argentina "virtual UTC" so we can do UTC date arithmetic on local time
  const local = new Date(Date.now() - BUE_MS);
  local.setUTCHours(0, 0, 0, 0);          // truncate to local midnight
  local.setUTCDate(local.getUTCDate() + days); // add N days
  return new Date(local.getTime() + BUE_MS);   // shift back to real UTC
}

/**
 * A micro-card is considered mastered when its interval reaches 7+ days.
 * At that point it gets archived and stops appearing in sessions.
 */
export const MICRO_MASTERY_THRESHOLD_DAYS = 7;
