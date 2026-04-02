-- Señales de scoring para auditoría offline y cruce con decisión humana.

BEGIN;

CREATE TABLE IF NOT EXISTS evaluation_signals (
    id BIGSERIAL PRIMARY KEY,
    evaluation_item_id BIGINT NOT NULL,
    evaluation_id UUID NOT NULL,
    prompt_text TEXT NOT NULL,
    subject VARCHAR(100),
    keyword_coverage NUMERIC(6,5) NOT NULL CHECK (keyword_coverage >= 0 AND keyword_coverage <= 1),
    answer_length_ratio NUMERIC(6,5) NOT NULL CHECK (answer_length_ratio >= 0 AND answer_length_ratio <= 1),
    lexical_similarity NUMERIC(6,5) NOT NULL CHECK (lexical_similarity >= 0 AND lexical_similarity <= 1),
    dimensions JSONB NOT NULL,
    suggested_grade VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_evaluation_signals_evaluation_item
      FOREIGN KEY (evaluation_item_id)
      REFERENCES evaluation_items (id)
      ON DELETE CASCADE,
    CONSTRAINT uq_evaluation_signals_evaluation_id UNIQUE (evaluation_id)
);

CREATE INDEX IF NOT EXISTS idx_evaluation_signals_created_at
  ON evaluation_signals (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_evaluation_signals_suggested_grade
  ON evaluation_signals (suggested_grade);

COMMIT;
