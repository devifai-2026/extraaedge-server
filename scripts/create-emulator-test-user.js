// One-shot: create a throwaway counsellor user under the "demo" tenant for an
// Android emulator end-to-end test of the recorder-app sync pipeline.
// Usage: node scripts/create-emulator-test-user.js
import 'dotenv/config';
import argon2 from 'argon2';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { resolveTenantBySlug, tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';

const SLUG = 'demo';
const PHONE = '9999999999';
const EMAIL = 'claude.emulator.test@example.invalid';

const tenant = await resolveTenantBySlug(SLUG);
if (!tenant) {
  console.error(`No tenant with slug "${SLUG}"`);
  process.exit(1);
}

console.log('Tenant:', tenant.slug, tenant.dbName ?? tenant.db_name);
console.log('recorder_folder_path:', tenant.recorder_folder_path ?? tenant.recorderFolderPath);
console.log('recorder_sync_hour:', tenant.recorder_sync_hour ?? tenant.recorderSyncHour);

const { rows: existing } = await tenantQuery(
  tenant,
  `SELECT id, name, phone, is_active FROM users WHERE deleted_at IS NULL AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10) = $1`,
  [PHONE],
);
if (existing[0]) {
  console.log('User already exists, reusing:', existing[0]);
  await closeAllTenantPools();
  await closeSystemPool();
  process.exit(0);
}

const { rows: roleRows } = await tenantQuery(
  tenant,
  `SELECT id FROM custom_roles WHERE name = 'counsellor' AND deleted_at IS NULL LIMIT 1`,
);
const roleId = roleRows[0]?.id ?? null;

const hash = await argon2.hash('ClaudeEmulatorTest!123', {
  type: argon2.argon2id,
  memoryCost: 1 << 16,
  timeCost: 3,
  parallelism: 1,
});

const { rows: inserted } = await tenantQuery(
  tenant,
  `INSERT INTO users (name, email, phone, password_hash, role, role_id, is_active)
   VALUES ($1, $2, $3, $4, 'counsellor', $5, true)
   RETURNING id, name, phone, role`,
  ['Claude Emulator Test', EMAIL, PHONE, hash, roleId],
);

console.log('Created user:', inserted[0]);

await closeAllTenantPools();
await closeSystemPool();
