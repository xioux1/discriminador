import { Router } from 'express';
import { createHash } from 'crypto';
import OpenAI from 'openai';
import { pinyin } from 'pinyin-pro';
import { dbPool } from '../db/client.js';
import { llmRateLimit } from '../middleware/llm-rate-limit.js';

const ttsRouter = Router();

let _client = null;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

/** Convert hanzi to toned pinyin string, e.g. "你好" → "nǐ hǎo" */
function hanziToPinyin(text) {
  try {
    return pinyin(text, { toneType: 'symbol', separator: ' ', nonZh: 'consecutive' }).trim();
  } catch {
    return '';
  }
}

// POST /tts — convert Chinese text to speech (MP3, base64-encoded)
// Results are cached permanently in the tts_cache table so the OpenAI API
// is only called once per unique text string.
// Response includes { audio, pinyin, cached } so the frontend can display
// romanisation without a separate API call.
ttsRouter.post('/tts', llmRateLimit, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'service_unavailable', message: 'OPENAI_API_KEY not configured.' });
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
  const hash  = createHash('sha256').update(`${voiceProfile}::${input}`).digest('hex');

  // 1. Check persistent cache
  try {
    const { rows } = await dbPool.query(
      'SELECT audio_b64, pinyin_text FROM tts_cache WHERE text_hash = $1',
      [hash],
    );
    if (rows.length > 0) {
      const row = rows[0];
      // Back-fill pinyin if an old cache row lacks it (migration added column later)
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

  const ttsInstructions = useChineseVoice
    ? '以标准普通话朗读以下中文文本，发音清晰准确。Read the following Chinese text in standard Mandarin (普通话) with clear and accurate pronunciation.'
    : 'Leé el siguiente texto en español neutro latinoamericano, con pronunciación clara y natural.';

  // 2. Generate via OpenAI.
  let audioB64;
  try {
    const response = await getClient().audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: 'nova',
      input,
      instructions: ttsInstructions,
      response_format: 'mp3',
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    audioB64 = buffer.toString('base64');
  } catch (err) {
    console.error('POST /tts OpenAI error:', err.message);
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
