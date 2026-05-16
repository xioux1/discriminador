CREATE TABLE IF NOT EXISTS card_explanation_artifacts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id         BIGINT      NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  user_id         INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version         INTEGER     NOT NULL DEFAULT 1,
  language        TEXT        NOT NULL DEFAULT 'es',
  expected_answer TEXT,
  oral_explanation_short    TEXT,
  oral_explanation_detailed TEXT,
  diagram_type    TEXT,
  diagram_spec    JSONB,
  reveal_steps    JSONB,
  quality_flags   JSONB,
  model_name      TEXT,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_card_explanation_artifacts_card UNIQUE (card_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_explanation_artifacts_card_user
  ON card_explanation_artifacts (card_id, user_id);
