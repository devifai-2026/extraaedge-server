import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { closeSystemPool } from './db/system.js';
import { closeAllTenantPools } from './db/tenant.js';
import { closeRedis } from './lib/redis.js';
import { closeQueues } from './lib/queue.js';
import { initSocket } from './lib/socket.js';
import { loadInprocessWorkers } from './workers/load-inprocess.js';

// Worker loading lives in workers/load-inprocess.js so this entry point and
// app.js (which is what Passenger actually starts in production) can never
// again drift apart on which workers exist. The loader is a no-op under BullMQ
// and is idempotent, so calling it here as well as from app.js is safe.
//
// Called AFTER listen(): importing these opens DB pools and starts schedulers,
// which can exceed the ~3s deadline Hostinger's Node hosting allows before it
// expects app.listen() ("App did not call listen() within 3 seconds").
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
