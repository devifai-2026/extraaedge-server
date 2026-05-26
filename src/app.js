import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { env, corsOrigins } from './config/env.js';
import { logger } from './lib/logger.js';
import { requestId } from './middleware/requestId.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { mountRoutes } from './routes.js';
import { getSystemPool } from './db/system.js';
import { runTenantMigrations } from './lib/run-tenant-migrations.js';

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
        if (!origin || allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
        cb(new Error('CORS_ORIGIN_NOT_ALLOWED'));
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

  // All API routes
  mountRoutes(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
};
