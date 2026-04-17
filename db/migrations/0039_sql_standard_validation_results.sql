CREATE TABLE IF NOT EXISTS sql_standard_validation_results (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_id      INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  standard_id  INTEGER NOT NULL REFERENCES sql_coding_standards(id) ON DELETE CASCADE,
  violations   JSONB NOT NULL DEFAULT '[]',
  compliant    BOOLEAN NOT NULL,
  validated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sql_val_results_card_standard
  ON sql_standard_validation_results(card_id, standard_id);

CREATE INDEX IF NOT EXISTS idx_sql_val_results_user_card
  ON sql_standard_validation_results(user_id, card_id);
