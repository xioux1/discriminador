import { Router } from 'express';
import OpenAI from 'openai';

const ttsRouter = Router();

let _client = null;
function getClient() {
  if (!_client) _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

// POST /tts — convert text to speech (MP3, base64-encoded)
// Used for Chinese (Hanzi) cards: auto-plays when the expected answer is revealed.
ttsRouter.post('/tts', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'service_unavailable', message: 'OPENAI_API_KEY not configured.' });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(422).json({ error: 'validation_error', message: 'text es obligatorio.' });
  }

  try {
    const response = await getClient().audio.speech.create({
      model: 'tts-1',
      voice: 'nova',       // clear, natural voice — works well for Mandarin
      input: text.trim(),
      response_format: 'mp3',
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    return res.json({ audio: buffer.toString('base64') });
  } catch (err) {
    console.error('POST /tts error:', err.message);
    return res.status(500).json({ error: 'server_error', message: err.message });
  }
});

export default ttsRouter;
