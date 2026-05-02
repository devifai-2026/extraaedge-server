// One-shot local dev setup: create system DB if missing, run migrations, bootstrap product_owner, provision a demo tenant.
// Usage:
//   node scripts/setup-local.js
// Requires: Postgres running locally, env.SYSTEM_DB_USER has CREATEDB privilege.

import pg from 'pg';
import { env } from '../src/config/env.js';
import { logger } from '../src/lib/logger.js';
import { spawnSync } from 'node:child_process';

const { Client } = pg;

const ensureSystemDb = async () => {
  const admin = new Client({
    host: env.TENANT_DB_HOST,
    port: env.TENANT_DB_PORT,
    database: 'postgres',
    user: env.TENANT_DB_SUPERUSER,
    password: env.TENANT_DB_SUPERUSER_PASSWORD,
    ssl: env.TENANT_DB_SSL ? { rejectUnauthorized: false } : false,
  });
  await admin.connect();
  try {
    const role = await admin.query(`SELECT 1 FROM pg_roles WHERE rolname = $1`, [env.SYSTEM_DB_USER]);
    if (!role.rowCount) {
      await admin.query(`CREATE ROLE "${env.SYSTEM_DB_USER}" LOGIN PASSWORD '${env.SYSTEM_DB_PASSWORD.replace(/'/g, "''")}' CREATEDB`);
    }
    const db = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [env.SYSTEM_DB_NAME]);
    if (!db.rowCount) {
      await admin.query(`CREATE DATABASE "${env.SYSTEM_DB_NAME}" OWNER "${env.SYSTEM_DB_USER}" ENCODING 'UTF8'`);
    }
  } finally {
    await admin.end();
  }
};

const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
};

const PRODUCT_OWNER_EMAIL = 'owner' + '@' + 'extraaedge.local';
const DEMO_ADMIN_EMAIL = 'admin' + '@' + 'demo.local';

const main = async () => {
  logger.info('Creating system DB if missing…');
  await ensureSystemDb();
  logger.info('Running system migrations…');
  run('node', ['scripts/run-migrations.js', '--target=system']);
  logger.info('Bootstrapping product_owner (demo credentials)…');
  run('node', ['scripts/create-product-owner.js', '--name=ProductOwner', `--email=${PRODUCT_OWNER_EMAIL}`, '--password=ChangeMe123!']);
  logger.info('Provisioning demo tenant…');
  run('node', ['scripts/provision-tenant.js', '--name=DemoInstitute', '--slug=demo', '--admin-name=DemoAdmin', `--admin-email=${DEMO_ADMIN_EMAIL}`, '--admin-password=ChangeMe123!']);
  logger.info('Setup complete. Start with: npm run dev');
};

main().catch((err) => {
  logger.fatal({ err: err.message, stack: err.stack }, 'setup failed');
  process.exit(1);
});
