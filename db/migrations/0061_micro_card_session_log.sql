-- Tracks every individual micro-card review so that reviewCard() can detect
-- intra-session contamination: if the student failed any micro-card for a
-- given parent earlier in the same session and then answers the parent
-- correctly, the "good" was scaffolded — not independent recall.
CREATE TABLE IF NOT EXISTS micro_card_session_log (
  id              SERIAL PRIMARY KEY,
  micro_card_id   INT  REFERENCES micro_cards(id) ON DELETE CASCADE,
  parent_card_id  INT  REFERENCES cards(id)       ON DELETE CASCADE,
  user_id         INT  REFERENCES users(id)        ON DELETE CASCADE,
  grade           TEXT NOT NULL,
  reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS micro_card_session_log_lookup
  ON micro_card_session_log(parent_card_id, user_id, reviewed_at);
