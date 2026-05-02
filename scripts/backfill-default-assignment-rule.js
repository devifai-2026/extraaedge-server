// One-shot: insert a "Default round-robin" rule for every tenant that
// currently has no assignment_rules. Idempotent — running twice is safe.
//
//   node scripts/backfill-default-assignment-rule.js
//   node scripts/backfill-default-assignment-rule.js --slug=brightpath-academy
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery } from '../src/db/tenant.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const log = (m) => console.log(m);

let q = `SELECT id, slug, status, db_name, db_user, db_password_encrypted FROM tenants WHERE deleted_at IS NULL`;
const params = [];
if (args.slug) { params.push(args.slug); q += ` AND slug = $${params.length}`; }

const { rows: tenants } = await sysQuery(q, params);
for (const tenant of tenants) {
  const existing = await tenantQuery(tenant, `SELECT count(*)::int AS n FROM assignment_rules WHERE deleted_at IS NULL`);
  if (existing.rows[0].n > 0) {
    log(`[${tenant.slug}] already has ${existing.rows[0].n} rule(s) — skipping`);
    continue;
  }
  const r = await tenantQuery(
    tenant,
    `INSERT INTO assignment_rules (name, priority, condition_json, strategy, is_active)
     VALUES ('Default round-robin', 1000, '{}'::jsonb, 'round_robin', true)
     RETURNING id`,
  );
  const ruleId = r.rows[0].id;
  await tenantQuery(
    tenant,
    `INSERT INTO assignment_rule_state (rule_id, last_assigned_user_id, total_assignments)
     VALUES ($1, NULL, 0)
     ON CONFLICT (rule_id) DO NOTHING`,
    [ruleId],
  );
  log(`[${tenant.slug}] seeded Default round-robin (${ruleId})`);
}
await closeSystemPool();
