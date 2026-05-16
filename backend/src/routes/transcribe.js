import { Router } from 'express';
import { createClient } from '@deepgram/sdk';
import { llmRateLimit } from '../middleware/llm-rate-limit.js';

const transcribeRouter = Router();

let _client = null;

function getClient() {
  if (!_client) {
    _client = createClient(process.env.DEEPGRAM_API_KEY);
  }
  return _client;
}

transcribeRouter.post('/transcribe', llmRateLimit, async (req, res) => {
  if (!process.env.DEEPGRAM_API_KEY) {
    return res.status(503).json({
      error: 'service_unavailable',
      message: 'DEEPGRAM_API_KEY is not configured.'
    });
  }

  if (!req.is('application/json')) {
    return res.status(400).json({
      error: 'bad_request',
      message: 'Expected application/json.'
    });
  }

  const { audio, mime_type } = req.body;

  if (!audio || typeof audio !== 'string') {
    return res.status(422).json({
      error: 'validation_error',
      message: 'audio field is required and must be a base64 string.'
    });
  }

  // 25 MB limit; base64 adds ~33% overhead → ~34 MB base64 string max
  const MAX_AUDIO_BASE64_BYTES = 34 * 1024 * 1024;
  if (Buffer.byteLength(audio, 'utf8') > MAX_AUDIO_BASE64_BYTES) {
    return res.status(413).json({
      error: 'payload_too_large',
      message: 'El audio supera el límite de 25 MB.'
    });
  }

  const mimeType = typeof mime_type === 'string' ? mime_type : 'audio/webm';

  try {
    const buffer = Buffer.from(audio, 'base64');

    const { result, error } = await getClient().listen.prerecorded.transcribeFile(
      buffer,
      {
        model: 'nova-2',
        language: 'es',
        smart_format: true,
        punctuate: true,
        mimetype: mimeType,
      }
    );

    if (error) throw error;

    const text = result?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
    return res.status(200).json({ text });
  } catch (error) {
    console.error('Transcription failed', { message: error.message });
    return res.status(500).json({
      error: 'server_error',
      message: 'Transcription failed.'
    });
  }
});

export default transcribeRouter;
