// Diagnostic — print active rules + working hours for brightpath
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery } from '../src/db/tenant.js';

const { rows: tenants } = await sysQuery(
  `SELECT id, slug, status, db_name, db_user, db_password_encrypted FROM tenants WHERE slug = 'brightpath-academy'`,
);
const tenant = tenants[0];

const r = await tenantQuery(tenant, `SELECT id, name, strategy, is_active, priority, target_users, fallback_user_id, respect_working_hours, skip_unavailable FROM assignment_rules WHERE deleted_at IS NULL ORDER BY priority`);
console.log('rules:');
for (const x of r.rows) console.log(' ', x);

const u = await tenantQuery(tenant, `SELECT id, name, role, is_active, timezone FROM users WHERE deleted_at IS NULL ORDER BY role, name`);
console.log('\nusers:');
for (const x of u.rows) console.log(' ', x);

const wh = await tenantQuery(tenant, `SELECT user_id, day_of_week, is_open, open_time, close_time FROM user_working_hours ORDER BY user_id, day_of_week`);
console.log('\nworking_hours rows:', wh.rows.length);
for (const x of wh.rows.slice(0, 20)) console.log(' ', x);

const ua = await tenantQuery(tenant, `SELECT user_id, starts_at, ends_at FROM user_availability WHERE deleted_at IS NULL AND now() BETWEEN starts_at AND ends_at`);
console.log('\nactive user_availability blocks:', ua.rows.length);

await closeSystemPool();
