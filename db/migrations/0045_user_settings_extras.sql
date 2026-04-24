ALTER TABLE user_settings
  ADD COLUMN IF NOT EXISTS planner_gate_enabled        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS default_retention_floor     INTEGER,  -- 50-99, NULL = use hardcoded 75
  ADD COLUMN IF NOT EXISTS default_grading_strictness  INTEGER;  -- 0-10,  NULL = use hardcoded 5
