// Programmatic tenant-migration runner. Mirrors scripts/run-migrations.js but
// importable from inside the running server — used by the one-shot HTTP
// trigger in app.js when Shell access isn't available (free-tier Render).
//
// Returns a report array { slug, ok, error? } so the HTTP caller can see
// which tenants migrated and which failed. Already-applied migrations are
// no-ops (node-pg-migrate tracks state in the `pgmigrations` table).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import migrationRunner from 'node-pg-migrate';
import { env } from '../config/env.js';
import { sysQuery } from '../db/system.js';
import { decrypt } from './crypto.js';
import { logger } from './logger.js';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(thisDir, '../db/migrations/tenant');
const SYSTEM_MIGRATIONS_DIR = path.resolve(thisDir, '../db/migrations/system');

// Run pending SYSTEM-db migrations (the shared tenants/platform tables, incl.
// platform_request_log). Importable from the running server for the one-shot
// HTTP trigger. Already-applied migrations are no-ops.
export const runSystemMigrations = async () => {
  await migrationRunner({
    databaseUrl: {
      host: env.SYSTEM_DB_HOST,
      port: env.SYSTEM_DB_PORT,
      database: env.SYSTEM_DB_NAME,
      user: env.SYSTEM_DB_USER,
      password: env.SYSTEM_DB_PASSWORD,
      ssl: env.SYSTEM_DB_SSL ? { rejectUnauthorized: false } : false,
    },
    dir: SYSTEM_MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: (m) => logger.info(`[system-migrate] ${m}`),
    verbose: false,
  });
  return { ok: true };
};

const migrateOneTenant = async (tenant) => {
  await migrationRunner({
    databaseUrl: {
      host: env.TENANT_DB_HOST,
      port: env.TENANT_DB_PORT,
      database: tenant.db_name,
      user: tenant.db_user,
      password: decrypt(tenant.db_password_encrypted),
      ssl: env.TENANT_DB_SSL ? { rejectUnauthorized: false } : false,
    },
    dir: MIGRATIONS_DIR,
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: (m) => logger.info(`[tenant-migrate ${tenant.slug}] ${m}`),
    verbose: false,
  });
};

export const runTenantMigrations = async () => {
  const { rows: tenants } = await sysQuery(
    `SELECT id, slug, db_name, db_user, db_password_encrypted FROM tenants WHERE deleted_at IS NULL`,
  );
  const report = [];
  for (const t of tenants) {
    try {
      await migrateOneTenant(t);
      report.push({ slug: t.slug, ok: true });
    } catch (err) {
      logger.error({ tenant: t.slug, err: err.message }, 'tenant migrate failed');
      report.push({ slug: t.slug, ok: false, error: err.message });
    }
  }
  return { count: tenants.length, tenants: report };
};
