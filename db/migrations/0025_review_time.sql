-- Migration: 0025_review_time
-- Adds review_time_ms (time from answer revealed → Siguiente) to activity_log and cards.
-- Active time (response_time_ms) = time solving; review time = time reading the answer.

ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS review_time_ms INT;
ALTER TABLE cards         ADD COLUMN IF NOT EXISTS avg_review_time_ms INT;
