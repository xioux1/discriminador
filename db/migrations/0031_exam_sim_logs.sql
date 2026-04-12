-- Migration 0031: log exam simulation results for advisor recalibration
CREATE TABLE IF NOT EXISTS exam_sim_logs (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  correct     INTEGER NOT NULL,
  total       INTEGER NOT NULL,
  score_pct   INTEGER NOT NULL,
  -- JSONB array: [{card_id, grade, prompt_text, passed, weakness_score}]
  results     JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exam_sim_logs_user_subject
  ON exam_sim_logs (user_id, subject, created_at DESC);
