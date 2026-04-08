-- Migration: 0021_audit_fixes
-- Fixes found during audit:
-- 1. subject_configs had UNIQUE(subject) globally, should be per user (subject, user_id)
-- 2. Missing compound indexes on hot query paths: micro_cards and cards scheduler queries

-- Fix UNIQUE constraint on subject_configs: drop global unique, add per-user unique
-- (safe: only one user per installation in practice, but correct for multi-user)
ALTER TABLE subject_configs DROP CONSTRAINT IF EXISTS subject_configs_subject_key;
ALTER TABLE subject_configs ADD CONSTRAINT IF NOT EXISTS subject_configs_subject_user_key
  UNIQUE (subject, user_id);

-- Compound index for scheduler micro_cards query: WHERE user_id=$1 AND status='active' AND next_review_at<=now()
CREATE INDEX IF NOT EXISTS idx_micro_cards_user_status_review
  ON micro_cards(user_id, status, next_review_at);

-- Compound index for scheduler cards query: WHERE user_id=$1 AND next_review_at<=now() AND archived_at IS NULL
CREATE INDEX IF NOT EXISTS idx_cards_user_review_active
  ON cards(user_id, next_review_at)
  WHERE archived_at IS NULL AND suspended_at IS NULL;
