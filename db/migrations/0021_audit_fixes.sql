-- Migration: 0021_audit_fixes
-- 1. subject_configs: reemplaza UNIQUE(subject) global por UNIQUE(subject, user_id)
-- 2. Índices compuestos en hot paths del scheduler

ALTER TABLE subject_configs DROP CONSTRAINT IF EXISTS subject_configs_subject_key;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'subject_configs_subject_user_key'
  ) THEN
    ALTER TABLE subject_configs
      ADD CONSTRAINT subject_configs_subject_user_key UNIQUE (subject, user_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_micro_cards_user_status_review
  ON micro_cards(user_id, status, next_review_at);

CREATE INDEX IF NOT EXISTS idx_cards_user_review_active
  ON cards(user_id, next_review_at)
  WHERE archived_at IS NULL AND suspended_at IS NULL;
