// Backfill: every tenant must have exactly one rule per strategy. Existing
// tenants probably only have a single round_robin from earlier provisioning;
// this script fills in the missing 5 strategies (load_balanced, by_program,
// by_geography, specific_user, team_round_robin) as inactive rows.
//
// Idempotent — re-running won't insert duplicates.
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery } from '../src/db/tenant.js';

const STRATEGIES = [
  { name: 'Round Robin',        strategy: 'round_robin',      priority: 100, is_active: true  },
  { name: 'Load Balanced',      strategy: 'load_balanced',    priority: 200, is_active: false },
  { name: 'By Program',         strategy: 'by_program',       priority: 300, is_active: false },
  { name: 'By Geography',       strategy: 'by_geography',     priority: 400, is_active: false },
  { name: 'Specific User',      strategy: 'specific_user',    priority: 500, is_active: false },
  { name: 'Team Round Robin',   strategy: 'team_round_robin', priority: 600, is_active: false },
];

const { rows: tenants } = await sysQuery(
  `SELECT id, slug, status, db_name, db_user, db_password_encrypted FROM tenants WHERE deleted_at IS NULL`,
);

for (const tenant of tenants) {
  const { rows: existing } = await tenantQuery(
    tenant,
    `SELECT strategy FROM assignment_rules WHERE deleted_at IS NULL`,
  );
  const haveStrats = new Set(existing.map((r) => r.strategy));
  const haveActive = existing.length > 0; // does any rule already exist? then we won't activate the new round_robin

  let inserted = 0;
  for (const s of STRATEGIES) {
    if (haveStrats.has(s.strategy)) continue;
    // Only auto-activate the round_robin if no other rules exist yet.
    const isActive = s.is_active && !haveActive;
    const { rows: r } = await tenantQuery(
      tenant,
      `INSERT INTO assignment_rules (name, priority, condition_json, strategy, is_active)
       VALUES ($1, $2, '{}'::jsonb, $3, $4)
       RETURNING id`,
      [s.name, s.priority, s.strategy, isActive],
    );
    await tenantQuery(
      tenant,
      `INSERT INTO assignment_rule_state (rule_id, last_assigned_user_id, total_assignments)
       VALUES ($1, NULL, 0) ON CONFLICT (rule_id) DO NOTHING`,
      [r[0].id],
    );
    inserted += 1;
  }
  console.log(`[${tenant.slug}] seeded ${inserted} new rule template(s) (had ${existing.length}, now ${existing.length + inserted})`);
}

await closeSystemPool();
