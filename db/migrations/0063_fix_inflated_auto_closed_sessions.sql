-- Migration: 0063_fix_inflated_auto_closed_sessions
-- The POST /study/sessions auto-close logic (now reverted) set ended_at = now()
-- for orphaned sessions, creating rows with actual_minutes spanning many hours.
-- This resets those rows back to their original orphaned state so they don't
-- pollute the planner grid.
--
-- Criteria for "inflated": actual_minutes > planned_minutes * 3, capped at 120 min.
-- Sessions closed legitimately (within 3× planned time) are left untouched.

UPDATE study_sessions
SET
  ended_at       = NULL,
  actual_minutes = NULL
WHERE ended_at IS NOT NULL
  AND actual_minutes IS NOT NULL
  AND actual_minutes > GREATEST(planned_minutes * 3, 120);
