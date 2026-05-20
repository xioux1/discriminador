-- Migration: 0092_subject_learning_config
ALTER TABLE subject_configs
  ADD COLUMN IF NOT EXISTS learning_steps             TEXT         NOT NULL DEFAULT '1m 10m',
  ADD COLUMN IF NOT EXISTS new_card_insertion_order   TEXT         NOT NULL DEFAULT 'sequential';
