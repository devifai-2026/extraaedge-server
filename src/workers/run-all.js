// Runs all workers in-process — convenient for dev. In prod, prefer systemd units per worker.
import './email-sender.js';
import './sms-sender.js';
// (whatsapp-sender removed — automated WhatsApp disabled; per-user manual chat
//  runs in the separate `npm run gateway` process via whatsapp-web.js.)
import './notification-worker.js';
import './bulk-import-worker.js';
import './bulk-export-worker.js';
import './campaign-runner.js';
import './drip-scheduler.js';
import './scheduled-send-runner.js';
import './workflow-executor.js';
import './rule-processor.js';
import './outbound-webhook-dispatcher.js';
import './pdf-report-worker.js';
import './duplicate-scanner.js';
import './followup-reminder-scheduler.js';
import './missed-followup-scanner.js';
import './sla-scanner.js';
import './referral-crediter.js';
import './attribution-snapshotter.js';
import './touch-recorder.js';
import { logger } from '../lib/logger.js';
logger.info('all workers started');
