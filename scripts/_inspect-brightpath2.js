// Print Priya Sharma's row as the leads.list API returns it.
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import * as repo from '../src/modules/leads/repo.js';

const { rows: tenants } = await sysQuery(
  `SELECT id, slug, status, db_name, db_user, db_password_encrypted FROM tenants WHERE slug = 'brightpath-academy'`,
);
const tenant = tenants[0];

const res = await repo.list(tenant, { sort: 'created_desc', page: 1, limit: 5 }, null);
console.log('rows:');
for (const r of res.rows) {
  console.log(' ', r.name, '| assigned_to:', r.assigned_to, '| assigned_to_name:', r.assigned_to_name, '| manager_name:', r.manager_name);
}
await closeSystemPool();
