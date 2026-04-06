-- Create users table
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Add user_id to all user-scoped tables (nullable for existing rows)
ALTER TABLE evaluation_items  ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE user_decisions     ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE evaluation_signals ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE concept_gaps       ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE cards              ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE micro_cards        ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE card_variants      ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE activity_log       ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE subject_configs    ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);
ALTER TABLE reference_exams    ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_cards_user_id         ON cards(user_id);
CREATE INDEX IF NOT EXISTS idx_micro_cards_user_id   ON micro_cards(user_id);
CREATE INDEX IF NOT EXISTS idx_eval_items_user_id    ON evaluation_items(user_id);
CREATE INDEX IF NOT EXISTS idx_user_decisions_uid    ON user_decisions(user_id);
CREATE INDEX IF NOT EXISTS idx_activity_log_uid      ON activity_log(user_id);
CREATE INDEX IF NOT EXISTS idx_subject_configs_uid   ON subject_configs(user_id);
CREATE INDEX IF NOT EXISTS idx_reference_exams_uid   ON reference_exams(user_id);
