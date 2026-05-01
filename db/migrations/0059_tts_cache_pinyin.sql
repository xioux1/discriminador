-- Migration 0059: add pinyin_text to tts_cache so romanisation is stored
-- alongside the audio and returned to the client without extra LLM calls.
ALTER TABLE tts_cache ADD COLUMN IF NOT EXISTS pinyin_text TEXT;
