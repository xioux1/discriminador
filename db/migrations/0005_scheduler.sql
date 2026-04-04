-- Migration: 0005_scheduler
-- Spaced repetition scheduler: full cards and concept-level micro-cards.

CREATE TABLE IF NOT EXISTS cards (
  id                    SERIAL PRIMARY KEY,
  subject               TEXT,
  prompt_text           TEXT NOT NULL,
  expected_answer_text  TEXT NOT NULL,
  next_review_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  interval_days         FLOAT       NOT NULL DEFAULT 1,
  ease_factor           FLOAT       NOT NULL DEFAULT 2.5,
  review_count          INT         NOT NULL DEFAULT 0,
  pass_count            INT         NOT NULL DEFAULT 0,
  last_reviewed_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS micro_cards (
  id                SERIAL PRIMARY KEY,
  parent_card_id    INT         NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  concept           TEXT        NOT NULL,        -- e.g. "función de control"
  question          TEXT        NOT NULL,        -- LLM-generated micro-question
  expected_answer   TEXT        NOT NULL,        -- LLM-generated concise answer
  next_review_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  interval_days     FLOAT       NOT NULL DEFAULT 1,
  ease_factor       FLOAT       NOT NULL DEFAULT 2.0,
  review_count      INT         NOT NULL DEFAULT 0,
  status            TEXT        NOT NULL DEFAULT 'active', -- active | archived
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cards_next_review_idx        ON cards(next_review_at);
CREATE INDEX IF NOT EXISTS cards_subject_idx            ON cards(subject);
CREATE INDEX IF NOT EXISTS micro_cards_parent_idx       ON micro_cards(parent_card_id);
CREATE INDEX IF NOT EXISTS micro_cards_status_review_idx ON micro_cards(status, next_review_at);
