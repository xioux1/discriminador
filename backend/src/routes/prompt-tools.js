import { Router } from 'express';
import { clarifyPrompt } from '../services/prompt-clarifier.js';

const promptToolsRouter = Router();

promptToolsRouter.post('/prompts/clarify', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'service_unavailable', message: 'Clarify service is not configured.' });
  }

  const promptText = typeof req.body?.prompt_text === 'string' ? req.body.prompt_text.trim() : '';
  if (promptText.length < 10) {
    return res.status(422).json({ error: 'validation_error', message: 'prompt_text must be at least 10 characters.' });
  }

  try {
    const clarified = await clarifyPrompt(promptText);
    return res.status(200).json({ clarified_prompt: clarified });
  } catch (err) {
    console.error('POST /prompts/clarify', err.message);
    return res.status(422).json({ error: 'clarify_error', message: err.message });
  }
});

export default promptToolsRouter;
