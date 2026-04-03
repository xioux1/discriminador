import { Router } from 'express';
import evaluateRouter from './evaluate.js';
import decisionRouter from './decision.js';
import transcribeRouter from './transcribe.js';
import lookupRouter from './lookup.js';

const router = Router();

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

router.use(evaluateRouter);
router.use(decisionRouter);
router.use(transcribeRouter);
router.use(lookupRouter);

export default router;
