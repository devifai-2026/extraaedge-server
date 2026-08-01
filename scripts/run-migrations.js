// Runs system migrations, or fan-outs tenant migrations across every tenant DB.
// Usage:
//   node scripts/run-migrations.js --target system
//   node scripts/run-migrations.js --target tenant
//   node scripts/run-migrations.js --target tenant --slug=demo

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import migrationRunner from 'node-pg-migrate';
import { env } from '../src/config/env.js';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { decrypt } from '../src/lib/crypto.js';
import { logger } from '../src/lib/logger.js';
const thisDir = path.dirname(fileURLToPath(import.meta.url));

// Accepts both `--target=tenant` and `--target tenant`. Only the first form
// used to parse: `--target tenant` set target=true and then died with
// "Unknown target: true", which is what `npm run migrate:tenant` expands to —
// so the npm aliases in package.json have never worked.
const parseArgs = () => {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const [key, inlineValue] = argv[i].replace(/^--/, '').split('=');
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
};

const migrateSystem = async () => {
  await migrationRunner({
    databaseUrl: {
      host: env.SYSTEM_DB_HOST,
      port: env.SYSTEM_DB_PORT,
      database: env.SYSTEM_DB_NAME,
      user: env.SYSTEM_DB_USER,
      password: env.SYSTEM_DB_PASSWORD,
      ssl: env.SYSTEM_DB_SSL ? { rejectUnauthorized: false } : false,
    },
    dir: path.resolve(thisDir, '../src/db/migrations/system'),
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: (m) => logger.info(`[system-migrate] ${m}`),
    verbose: false,
  });
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
    dir: path.resolve(thisDir, '../src/db/migrations/tenant'),
    migrationsTable: 'pgmigrations',
    direction: 'up',
    log: (m) => logger.info(`[tenant-migrate ${tenant.slug}] ${m}`),
    verbose: false,
  });
};

const main = async () => {
  const args = parseArgs();
  const target = args.target ?? 'system';
  if (target === 'system') {
    await migrateSystem();
    logger.info('system migrations done');
  } else if (target === 'tenant') {
    let q = `SELECT id, slug, db_name, db_user, db_password_encrypted FROM tenants WHERE deleted_at IS NULL`;
    const params = [];
    if (args.slug) { params.push(args.slug); q += ` AND slug = $${params.length}`; }
    const { rows: tenants } = await sysQuery(q, params);
    for (const t of tenants) {
      try {
        await migrateOneTenant(t);
      } catch (err) {
        logger.error({ tenant: t.slug, err: err.message }, 'tenant migrate failed');
        if (!args['continue-on-error']) throw err;
      }
    }
    logger.info(`tenant migrations done for ${tenants.length} tenant(s)`);
  } else {
    throw new Error(`Unknown target: ${target}`);
  }
  await closeSystemPool();
};

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'migration failed');
  process.exit(1);
});
