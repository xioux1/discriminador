import { Router } from 'express';
import evaluateRouter from './evaluate.js';
import decisionRouter from './decision.js';
import transcribeRouter from './transcribe.js';
import lookupRouter from './lookup.js';
import socraticRouter from './socratic.js';
import statsRouter from './stats.js';
import overviewRouter from './overview.js';
import schedulerRouter from './scheduler.js';
import activityRouter from './activity.js';
import curriculumRouter from './curriculum.js';
import advisorRouter from './advisor.js';
import sessionPlannerRouter from './session-planner.js';

const router = Router();

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

router.use(evaluateRouter);
router.use(decisionRouter);
router.use(transcribeRouter);
router.use(lookupRouter);
router.use(socraticRouter);
router.use(statsRouter);
router.use(overviewRouter);
router.use(schedulerRouter);
router.use(activityRouter);
router.use(curriculumRouter);
router.use(advisorRouter);
router.use(sessionPlannerRouter);

export default router;
