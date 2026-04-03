import { Router } from 'express';
import evaluateRouter from './evaluate.js';
import decisionRouter from './decision.js';
import transcribeRouter from './transcribe.js';

const router = Router();

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

router.use(evaluateRouter);
router.use(decisionRouter);
router.use(transcribeRouter);

export default router;
