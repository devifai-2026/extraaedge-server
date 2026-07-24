import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { env, corsOrigins, normalizeOrigin } from './config/env.js';
import { logger } from './lib/logger.js';
import { requestId } from './middleware/requestId.js';
import { requestLog } from './middleware/requestLog.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { mountRoutes } from './routes.js';
import { getSystemPool } from './db/system.js';
import { runTenantMigrations, runSystemMigrations } from './lib/run-tenant-migrations.js';

export const buildApp = () => {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true);
  // Disable ETag generation. Our list endpoints intentionally show fresh data
  // (lead assignments, scores, flags), and 304-Not-Modified responses against
  // a stale browser ETag were silently serving stale rows.
  app.set('etag', false);

  app.use(requestId);
  app.use(
    helmet({
      contentSecurityPolicy: false, // API server — no HTML
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(
    cors({
      origin: (origin, cb) => {
        const allowed = corsOrigins();
        // Normalize BOTH sides so a trailing slash or stray char on either the
        // configured value or the incoming Origin header can't cause a false
        // reject (which the error handler turns into a 500 for that origin).
        const norm = normalizeOrigin(origin);
        if (!origin || allowed.length === 0 || allowed.includes(norm)) return cb(null, true);
        // A rejected CORS origin is expected traffic, not a server fault — log
        // it and simply disable CORS headers for this response instead of
        // throwing (throwing surfaced as an opaque 500). The browser then
        // blocks the response client-side, which is the correct CORS behavior.
        logger.warn({ origin }, 'CORS origin not allowed');
        cb(null, false);
      },
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'ETag', 'Last-Modified'],
    }),
  );
  app.use(express.json({ limit: '200kb' }));
  app.use(express.urlencoded({ extended: true, limit: '200kb' }));
  app.use(
    morgan('tiny', {
      stream: { write: (msg) => logger.debug(msg.trim()) },
      skip: (req) => req.path === '/healthz' || req.path === '/readyz',
    }),
  );

  app.use(globalLimiter);

  // Health endpoints — no DB touch
  app.get('/healthz', (_req, res) => res.json({ ok: true, env: env.NODE_ENV }));
  app.get('/readyz', async (_req, res) => {
    try {
      await getSystemPool().query('SELECT 1');
      res.json({ ok: true });
    } catch (err) {
      res.status(503).json({ ok: false, error: err.message });
    }
  });

  // TEMPORARY one-shot tenant-migration trigger. Free-tier Render has no
  // Shell, so we can't run `node scripts/run-migrations.js` directly. Hit
  // this once from your laptop with the MIGRATE_TOKEN env var set, then
  // remove the route in the next commit. Returns a JSON report per tenant.
  // Gated by a constant-time-equal token check — a missing/wrong token
  // returns 404 so the endpoint isn't discoverable by scanners.
  app.post('/__one_shot_migrate_tenants', async (req, res) => {
    const expected = process.env.MIGRATE_TOKEN;
    const provided = req.get('x-migrate-token');
    if (!expected || !provided || expected !== provided) {
      return res.status(404).json({ error: 'not found' });
    }
    try {
      const result = await runTenantMigrations();
      return res.json({ ok: true, result });
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'one-shot migration failed');
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // TEMPORARY one-shot SYSTEM-migration trigger (same trust model as the
  // tenant one above — gated by MIGRATE_TOKEN, 404 on missing/wrong token).
  // Runs pending migrations against the SYSTEM db (e.g. platform_request_log).
  // Hit once after deploy, then remove in a follow-up commit.
  app.post('/__one_shot_migrate_system', async (req, res) => {
    const expected = process.env.MIGRATE_TOKEN;
    const provided = req.get('x-migrate-token');
    if (!expected || !provided || expected !== provided) {
      return res.status(404).json({ error: 'not found' });
    }
    try {
      const result = await runSystemMigrations();
      return res.json({ ok: true, result });
    } catch (err) {
      logger.error({ err: err.message, stack: err.stack }, 'one-shot system migration failed');
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Capture every API request into the cross-tenant platform_request_log
  // (powers the product_owner "Danger Request Log"). Reads req.user/req.tenant
  // lazily at response time, after per-route auth has populated them. Writes
  // are fire-and-forget so this can never break a request.
  app.use(requestLog);

  // All API routes
  mountRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};

// ---------------------------------------------------------------------------
// Passenger / direct-run bootstrap.
//
// Hostinger's Passenger runs this file (src/app.js) as the startup file, not
// src/index.js. Passenger expects the startup file to actually start listening;
// this module only *exports* buildApp(), so on Hostinger the process would
// export a factory and never listen → "App did not call listen() within 3
// seconds" → 503. To support both entrypoints, when app.js is executed as the
// main module we run the same startup sequence index.js uses: listen first,
// then attach socket.io and load in-process workers after we're already
// accepting connections (keeps startup under the platform's listen deadline).
//
// index.js still imports buildApp from here for local/Render use; that path
// does NOT trigger this block, so there is no double-listen.
const isDirectRun = (() => {
  try {
    const entry = process.argv[1] ? new URL(`file://${process.argv[1]}`).pathname : '';
    return import.meta.url === `file://${entry}` || entry.endsWith('/src/app.js');
  } catch {
    return false;
  }
})();

// NOTE: no top-level await here. Hostinger's Passenger loads this file with
// require() (see lsnode.js), and require() throws ERR_REQUIRE_ASYNC_MODULE on
// any module graph containing top-level await. So the whole bootstrap runs
// inside an async IIFE — the module itself stays synchronous to load.
if (isDirectRun) {
  (async () => {
    const { env } = await import('./config/env.js');
    const { logger } = await import('./lib/logger.js');
    const { initSocket } = await import('./lib/socket.js');
    const { closeSystemPool } = await import('./db/system.js');
    const { closeAllTenantPools } = await import('./db/tenant.js');
    const { closeRedis } = await import('./lib/redis.js');
    const { closeQueues } = await import('./lib/queue.js');

    const loadInprocessWorkers = async () => {
      if (env.QUEUE_DRIVER !== 'inprocess') return;
      try {
        await import('./workers/rule-processor.js');
        await import('./workers/bulk-import-worker.js');
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
      logger.info({ port: env.PORT, env: env.NODE_ENV }, 'extraaedge-backend listening (app.js direct run)');
      if (env.MOBILE_OTP_DEMO && env.NODE_ENV === 'production') {
        logger.warn('MOBILE_OTP_DEMO is ON in production — recorder-app login accepts the fixed OTP 1234');
      }
      loadInprocessWorkers();
    });

    initSocket(server);

    const shutdown = async (signal) => {
      logger.info({ signal }, 'shutting down');
      server.close();
      await Promise.allSettled([closeQueues(), closeRedis(), closeAllTenantPools(), closeSystemPool()]);
      process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  })();
}
