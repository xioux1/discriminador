import { Router } from 'express';
import { createHash } from 'crypto';
import { createClient } from '@deepgram/sdk';
import { pinyin } from 'pinyin-pro';
import { dbPool } from '../db/client.js';
import { llmRateLimit } from '../middleware/llm-rate-limit.js';

const ttsRouter = Router();

let _client = null;
function getClient() {
  if (!_client) _client = createClient(process.env.DEEPGRAM_API_KEY);
  return _client;
}

// Configure voices via env; defaults work for Spanish and Chinese (best-effort).
// Deepgram Aura does not officially support Chinese — set DEEPGRAM_TTS_VOICE_ZH
// to a multilingual model if one becomes available.
const VOICE_ES = process.env.DEEPGRAM_TTS_VOICE_ES || 'aura-asteria-en';
const VOICE_ZH = process.env.DEEPGRAM_TTS_VOICE_ZH || 'aura-asteria-en';

/** Convert hanzi to toned pinyin string, e.g. "你好" → "nǐ hǎo" */
function hanziToPinyin(text) {
  try {
    return pinyin(text, { toneType: 'symbol', separator: ' ', nonZh: 'consecutive' }).trim();
  } catch {
    return '';
  }
}

async function streamToBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

// POST /tts — convert text to speech (MP3, base64-encoded)
// Results are cached permanently in the tts_cache table so the Deepgram API
// is only called once per unique text string.
// Response includes { audio, pinyin, cached } so the frontend can display
// romanisation without a separate API call.
ttsRouter.post('/tts', llmRateLimit, async (req, res) => {
  if (!process.env.DEEPGRAM_API_KEY) {
    return res.status(503).json({ error: 'service_unavailable', message: 'DEEPGRAM_API_KEY not configured.' });
  }

  const { text, lang, mode } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(422).json({ error: 'validation_error', message: 'text es obligatorio.' });
  }

  const input = text.trim();
  const normalizedLang = typeof lang === 'string' ? lang.trim().toLowerCase() : '';
  const normalizedMode = typeof mode === 'string' ? mode.trim().toLowerCase() : '';
  const useChineseVoice = normalizedMode === 'chinese'
    || normalizedLang === 'zh'
    || normalizedLang === 'zh-cn'
    || normalizedLang === 'zh-hans';
  const voiceProfile = useChineseVoice ? 'zh' : 'es';
  const voiceModel = useChineseVoice ? VOICE_ZH : VOICE_ES;
  const hash = createHash('sha256').update(`${voiceProfile}::${input}`).digest('hex');

  // 1. Check persistent cache
  try {
    const { rows } = await dbPool.query(
      'SELECT audio_b64, pinyin_text FROM tts_cache WHERE text_hash = $1',
      [hash],
    );
    if (rows.length > 0) {
      const row = rows[0];
      const pinyinText = row.pinyin_text ?? hanziToPinyin(input);
      if (!row.pinyin_text) {
        dbPool.query('UPDATE tts_cache SET pinyin_text = $1 WHERE text_hash = $2', [pinyinText, hash])
          .catch(() => {});
      }
      return res.json({ audio: row.audio_b64, pinyin: pinyinText, cached: true });
    }
  } catch (err) {
    console.error('TTS cache read error:', err.message);
    // Non-fatal: fall through to generation
  }

  // 2. Generate via Deepgram
  let audioB64;
  try {
    const response = await getClient().speak.request(
      { text: input },
      { model: voiceModel, encoding: 'mp3' },
    );

    const stream = await response.getStream();
    const buffer = await streamToBuffer(stream);
    audioB64 = buffer.toString('base64');
  } catch (err) {
    console.error('POST /tts Deepgram error:', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }

  // 3. Generate pinyin with the local library (fast, deterministic, no extra API call)
  const pinyinText = hanziToPinyin(input);

  // 4. Persist to cache (best-effort)
  try {
    await dbPool.query(
      'INSERT INTO tts_cache (text_hash, audio_b64, pinyin_text) VALUES ($1, $2, $3) ON CONFLICT (text_hash) DO UPDATE SET pinyin_text = EXCLUDED.pinyin_text',
      [hash, audioB64, pinyinText],
    );
  } catch (err) {
    console.error('TTS cache write error:', err.message);
  }

  return res.json({ audio: audioB64, pinyin: pinyinText, cached: false });
});

export default ttsRouter;
