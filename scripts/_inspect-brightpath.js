// Diagnostic — print brightpath rules + users + recent leads.
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery } from '../src/db/tenant.js';

const { rows: tenants } = await sysQuery(
  `SELECT id, slug, status, db_name, db_user, db_password_encrypted FROM tenants WHERE slug = 'brightpath-academy'`,
);
const tenant = tenants[0];
if (!tenant) { console.error('not found'); process.exit(1); }

const r1 = await tenantQuery(tenant, `SELECT id, name, strategy, is_active, target_team_id, target_users, fallback_user_id FROM assignment_rules WHERE deleted_at IS NULL ORDER BY priority`);
console.log('rules:');
for (const r of r1.rows) console.log(' ', JSON.stringify(r));

const r2 = await tenantQuery(tenant, `SELECT id, name, role, is_active FROM users WHERE deleted_at IS NULL ORDER BY role, name`);
console.log('\nusers:');
for (const u of r2.rows) console.log(' ', u);

const r3 = await tenantQuery(tenant, `SELECT id, name, assigned_to, created_at FROM leads WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 5`);
console.log('\nrecent leads:');
for (const l of r3.rows) console.log(' ', l);

await closeSystemPool();
