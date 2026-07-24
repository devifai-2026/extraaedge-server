import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closeSystemPool } from './db/system.js';
import { closeAllTenantPools } from './db/tenant.js';
import { closeRedis } from './lib/redis.js';
import { closeQueues } from './lib/queue.js';
import { initSocket } from './lib/socket.js';

// In-process queue mode loads the worker modules so their handlers register on
// this same process (bullmq mode runs each worker as its own process instead).
// These imports open DB pools and start schedulers, which can take longer than
// Hostinger's Node hosting allows before it expects app.listen() (a ~3s deadline
// — see the "App did not call listen() within 3 seconds" runtime error). So we
// call listen() FIRST, then load the workers asynchronously after the server is
// already accepting connections. On Render/VPS this ordering is equally correct.
const loadInprocessWorkers = async () => {
  if (env.QUEUE_DRIVER !== 'inprocess') return;
  try {
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
    logger.info('in-process workers loaded');
  } catch (err) {
    logger.error({ err: err.message, stack: err.stack }, 'failed to load in-process workers');
  }
};

const app = buildApp();
const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, 'extraaedge-backend listening');
  if (env.MOBILE_OTP_DEMO && env.NODE_ENV === 'production') {
    logger.warn('MOBILE_OTP_DEMO is ON in production — recorder-app login accepts the fixed OTP 1234');
  }
  // Load workers only after we're listening, so a slow worker init can never
  // trip the platform's startup deadline. Fire-and-forget.
  loadInprocessWorkers();
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
// An unhandled rejection previously only logged — so when the DB pool wedged
// (connection-timeout rejections piling up), the process stayed alive but
// broken, serving 500s indefinitely until someone noticed. Track the rate;
// if rejections come in a sustained burst (a stuck pool, not a one-off), exit
// so Render's health check restarts us into a clean process with fresh pools.
let rejectionCount = 0;
let rejectionWindowStart = Date.now();
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'unhandled rejection');
  const now = Date.now();
  if (now - rejectionWindowStart > 60_000) { rejectionCount = 0; rejectionWindowStart = now; }
  rejectionCount += 1;
  if (rejectionCount >= 25) {
    logger.fatal({ rejectionCount }, 'unhandled-rejection storm — likely wedged (DB pool?); restarting');
    shutdown('unhandledRejection-storm').catch(() => process.exit(1));
  }
});
