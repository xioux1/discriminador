import 'dotenv/config';
import { runDailyReport } from '../src/services/dailyReport.service.js';

await runDailyReport();
process.exit(0);
