import { Router } from 'express';
import evaluateRouter from './evaluate.js';
import decisionRouter from './decision.js';

const router = Router();

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

router.use(evaluateRouter);
router.use(decisionRouter);

export default router;
