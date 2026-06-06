// WhatsApp gateway — a singleton, long-lived process that owns every user's
// whatsapp-web.js Client (headless Chromium) in memory. Started separately from
// the API: `npm run gateway`. The API reaches it over internal HTTP
// (src/lib/wa-gateway.js); it pushes events back to browsers via the API's
// socket.io (src/gateway/notify-api.js → POST /internal/wa/notify).
import express from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { closeSystemPool } from '../db/system.js';
import { closeAllTenantPools } from '../db/tenant.js';
import internalRoutes from './internal-routes.js';
import { restoreOnBoot, destroyAll } from './client-registry.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(internalRoutes);

const server = app.listen(env.WA_GATEWAY_PORT, () => {
  logger.info({ port: env.WA_GATEWAY_PORT }, 'whatsapp-gateway listening');
  // Re-link previously connected sessions from GCS (throttled). Fire-and-forget
  // so a slow restore doesn't block the HTTP server from accepting calls.
  restoreOnBoot().catch((err) => logger.error({ err: err.message }, 'wa restoreOnBoot failed'));
});

const shutdown = async (signal) => {
  logger.info({ signal }, 'whatsapp-gateway shutting down');
  server.close();
  // Destroy every Client cleanly so RemoteAuth flushes the session to GCS.
  await destroyAll().catch(() => {});
  await Promise.allSettled([closeAllTenantPools(), closeSystemPool()]);
  process.exit(0);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'gateway uncaught exception');
});
process.on('unhandledRejection', (reason) => {
  logger.error({ reason: String(reason) }, 'gateway unhandled rejection');
});
