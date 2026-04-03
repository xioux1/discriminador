import { Router } from 'express';
import OpenAI, { toFile } from 'openai';

const transcribeRouter = Router();

let _client = null;

function getClient() {
  if (!_client) {
    _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _client;
}

function mimeToExt(mimeType) {
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4')) return 'mp4';
  if (mimeType.includes('wav')) return 'wav';
  return 'webm';
}

transcribeRouter.post('/transcribe', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: 'service_unavailable',
      message: 'OPENAI_API_KEY is not configured.'
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

  const mimeType = typeof mime_type === 'string' ? mime_type : 'audio/webm';
  const ext = mimeToExt(mimeType);

  try {
    const buffer = Buffer.from(audio, 'base64');
    const file = await toFile(buffer, `audio.${ext}`, { type: mimeType });

    const transcription = await getClient().audio.transcriptions.create({
      file,
      model: 'whisper-1',
      language: 'es'
    });

    return res.status(200).json({ text: transcription.text });
  } catch (error) {
    console.error('Transcription failed', { message: error.message });
    return res.status(500).json({
      error: 'server_error',
      message: 'Transcription failed.'
    });
  }
});

export default transcribeRouter;
