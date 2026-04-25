-- Migration: 0042_bot_tables
-- Stores Discord bot conversations and subject snooze preferences.

CREATE TABLE IF NOT EXISTS bot_conversations (
  id                  SERIAL PRIMARY KEY,
  user_id             INTEGER NOT NULL REFERENCES users(id),
  discord_channel_id  TEXT    NOT NULL,
  discord_message_id  TEXT,
  direction           TEXT    NOT NULL CHECK (direction IN ('outbound', 'inbound')),
  subject             TEXT,
  body                TEXT    NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bot_conversations_user
  ON bot_conversations(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS subject_snooze (
  id            SERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  subject       TEXT    NOT NULL,
  reason        TEXT,
  snoozed_until DATE    NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, subject)
);
