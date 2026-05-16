-- Clear TTS cache entries generated with the old OpenAI English voice.
-- They will be regenerated on next request using Deepgram aura-2-antonia-es.
DELETE FROM tts_cache;
