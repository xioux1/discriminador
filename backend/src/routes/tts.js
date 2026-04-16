import { Router } from 'express';
import { createHash } from 'crypto';
import OpenAI from 'openai';
import { dbPool } from '../db/client.js';
import { llmRateLimit } from '../middleware/llm-rate-limit.js';

const ttsRouter = Router();

let _client = null;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

// POST /tts — convert Chinese text to speech (MP3, base64-encoded)
// Results are cached permanently in the tts_cache table so the OpenAI API
// is only called once per unique text string.
ttsRouter.post('/tts', llmRateLimit, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'service_unavailable', message: 'OPENAI_API_KEY not configured.' });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(422).json({ error: 'validation_error', message: 'text es obligatorio.' });
  }

  const input = text.trim();
  const hash  = createHash('sha256').update(input).digest('hex');

  // 1. Check persistent cache
  try {
    const { rows } = await dbPool.query(
      'SELECT audio_b64 FROM tts_cache WHERE text_hash = $1',
      [hash],
    );
    if (rows.length > 0) {
      return res.json({ audio: rows[0].audio_b64, cached: true });
    }
  } catch (err) {
    console.error('TTS cache read error:', err.message);
    // Non-fatal: fall through to generation
  }

  // 2. Generate via OpenAI — gpt-4o-mini-tts supports `instructions` to
  //    explicitly request standard Mandarin (普通话) pronunciation.
  let audioB64;
  try {
    const response = await getClient().audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
      input,
      instructions: '以标准普通话朗读以下中文文本，发音清晰准确。Read the following Chinese text in standard Mandarin (普通话) with clear and accurate pronunciation.',
      response_format: 'mp3',
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    audioB64 = buffer.toString('base64');
  } catch (err) {
    console.error('POST /tts OpenAI error:', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }

  // 3. Persist to cache (best-effort)
  try {
    await dbPool.query(
      'INSERT INTO tts_cache (text_hash, audio_b64) VALUES ($1, $2) ON CONFLICT (text_hash) DO NOTHING',
      [hash, audioB64],
    );
  } catch (err) {
    console.error('TTS cache write error:', err.message);
  }

  return res.json({ audio: audioB64, cached: false });
});

export default ttsRouter;
