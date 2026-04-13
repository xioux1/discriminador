-- Migration 0033: persistent TTS audio cache keyed by text hash
-- Avoids repeated OpenAI API calls for the same Hanzi text across sessions.
CREATE TABLE IF NOT EXISTS tts_cache (
  id          SERIAL PRIMARY KEY,
  text_hash   TEXT NOT NULL UNIQUE,   -- SHA-256 of the input text
  audio_b64   TEXT NOT NULL,          -- base64-encoded MP3
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tts_cache_hash ON tts_cache (text_hash);
