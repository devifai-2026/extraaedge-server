import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closeSystemPool } from './db/system.js';
import { closeAllTenantPools } from './db/tenant.js';
import { closeRedis } from './lib/redis.js';
import { closeQueues } from './lib/queue.js';
import { initSocket } from './lib/socket.js';

// In-process queue mode: import workers so their handlers register on the same process.
// (In production, QUEUE_DRIVER=bullmq runs each worker as its own process.)
if (env.QUEUE_DRIVER === 'inprocess') {
  await import('./workers/rule-processor.js');
  await import('./workers/bulk-import-worker.js');
  // Follow-up + notifications stack:
  //   notification-worker translates queued event types into
  //     notifications rows + websocket pushes.
  //   followup-reminder-scheduler scans lead_followups every minute and
  //     publishes 'follow_up_due' events when a planned follow-up's time
  //     is reached.
  //   missed-followup-scanner marks planned follow-ups as 'missed' once
  //     they're past-due by N hours and publishes 'follow_up_missed'.
  // Without these three the notifications popover stays empty for any
  // follow-up activity, even though /follow-ups/* CRUD works.
  await import('./workers/notification-worker.js');
  await import('./workers/followup-reminder-scheduler.js');
  await import('./workers/missed-followup-scanner.js');
  await import('./workers/lms-class-reminder.js');
}

const app = buildApp();
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'extraaedge-backend listening');
});

// Attach socket.io to the same HTTP server.
initSocket(server);

const shutdown = async (signal) => {
  logger.info({ signal }, 'shutting down');
  server.close();
  await Promise.allSettled([closeQueues(), closeRedis(), closeAllTenantPools(), closeSystemPool()]);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
  shutdown('uncaughtException').catch(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'unhandled rejection');
});
