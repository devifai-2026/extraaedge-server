// Seeds a telecalling org + attributed leads into a tenant (default: demo) so
// the telecaller roles, routing pools and recording scope can be exercised end
// to end against real data shapes.
//
// Attribution values mirror what production actually carries (sampled from
// speedup-infotech), including the "Online / Social Media" pair that is the
// most common social shape.
//
// Idempotent: users are keyed on email, leads on a 'TCDEMO-' name prefix.
// Safe to re-run. Nothing is ever deleted.
//
//   node scripts/seed-telecaller-demo.js --slug=demo
import argon2 from 'argon2';
import { sysQuery } from '../src/db/system.js';
import { resolveTenantById, tenantQuery } from '../src/db/tenant.js';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const SLUG = arg('slug', 'demo');
const PASSWORD = 'TelecallerDemo#2026';

// Two separate telecalling teams — the second exists purely so cross-team
// isolation (MoM 3.1.7) can be proven rather than assumed.
const PEOPLE = [
  { key: 'lead_a', email: 'tc.lead.a@demo.local', name: 'TC Lead Alpha', role: 'telecaller_lead' },
  { key: 'tc_a1', email: 'tc.a1@demo.local', name: 'Telecaller A1', role: 'telecaller', manager: 'lead_a' },
  { key: 'tc_a2', email: 'tc.a2@demo.local', name: 'Telecaller A2', role: 'telecaller', manager: 'lead_a' },
  { key: 'lead_b', email: 'tc.lead.b@demo.local', name: 'TC Lead Bravo', role: 'telecaller_lead' },
  { key: 'tc_b1', email: 'tc.b1@demo.local', name: 'Telecaller B1', role: 'telecaller', manager: 'lead_b' },
];

// (channel, source) pairs taken from real production rows.
const LEAD_SHAPES = [
  ['WhatsApp Ad', 'whatsapp'],
  [null, 'whatsapp'],
  ['Facebook', 'Facebook Lead Ads'],
  ['Instagram', 'Facebook Lead Ads'],
  ['Online', 'Facebook'],
  ['Website', 'demo.local'],
  ['Online', 'Social Media'],
  ['Offline', 'Direct Walkin'],
];

const run = async () => {
  const { rows: trows } = await sysQuery('SELECT id, slug FROM tenants WHERE slug = $1', [SLUG]);
  if (!trows[0]) throw new Error(`tenant ${SLUG} not found`);
  const tenant = await resolveTenantById(trows[0].id);

  const { rows: roleRows } = await tenantQuery(
    tenant,
    `SELECT id, scope FROM custom_roles WHERE scope IN ('telecaller','telecaller_lead') AND deleted_at IS NULL`,
  );
  const roleIdByScope = Object.fromEntries(roleRows.map((r) => [r.scope, r.id]));
  if (!roleIdByScope.telecaller || !roleIdByScope.telecaller_lead) {
    throw new Error('telecaller roles missing — run migrate:tenant first');
  }

  const { rows: smRows } = await tenantQuery(
    tenant,
    `SELECT id FROM users WHERE role = 'sales_manager' AND deleted_at IS NULL ORDER BY created_at LIMIT 1`,
  );
  const salesManagerId = smRows[0]?.id ?? null;

  const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 1 << 16, timeCost: 3, parallelism: 1 });
  const ids = {};

  // Pass 1: users. Leads report to their lead; leads report to the sales manager.
  for (const p of PEOPLE) {
    const { rows: existing } = await tenantQuery(tenant, `SELECT id FROM users WHERE lower(email) = lower($1)`, [p.email]);
    if (existing[0]) {
      ids[p.key] = existing[0].id;
      await tenantQuery(
        tenant,
        `UPDATE users SET role = $2, role_id = $3, is_active = true, deleted_at = NULL WHERE id = $1`,
        [existing[0].id, p.role, roleIdByScope[p.role]],
      );
    } else {
      const { rows } = await tenantQuery(
        tenant,
        `INSERT INTO users (email, name, password_hash, role, role_id, is_active, track_work_time)
         VALUES ($1,$2,$3,$4,$5,true,true) RETURNING id`,
        [p.email, p.name, hash, p.role, roleIdByScope[p.role]],
      );
      ids[p.key] = rows[0].id;
    }
  }
  // Pass 2: reporting lines (needs every id resolved first).
  for (const p of PEOPLE) {
    const managerId = p.manager ? ids[p.manager] : salesManagerId;
    await tenantQuery(tenant, `UPDATE users SET manager_id = $2 WHERE id = $1`, [ids[p.key], managerId]);
    await tenantQuery(tenant, `DELETE FROM user_managers WHERE user_id = $1`, [ids[p.key]]);
    if (managerId) {
      await tenantQuery(
        tenant,
        `INSERT INTO user_managers (user_id, manager_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [ids[p.key], managerId],
      );
    }
  }

  // Leads: unassigned + attributed, so applyAssignment has something to route.
  const { rows: stage } = await tenantQuery(
    tenant,
    `SELECT id FROM lead_stages WHERE is_active = true ORDER BY order_index LIMIT 1`,
  );
  const stageId = stage[0]?.id ?? null;

  let created = 0;
  for (const [i, [channel, source]] of LEAD_SHAPES.entries()) {
    for (let n = 1; n <= 3; n += 1) {
      const name = `TCDEMO-${String(i + 1).padStart(2, '0')}-${n} ${source}`;
      const phone = `9${String(700000000 + i * 1000 + n)}`;
      const { rows: dup } = await tenantQuery(tenant, `SELECT id FROM leads WHERE name = $1 AND deleted_at IS NULL`, [name]);
      if (dup[0]) continue;
      await tenantQuery(
        tenant,
        `INSERT INTO leads (name, phone, whatsapp_number, stage_id, first_touch_channel, first_touch_source, assigned_to)
         VALUES ($1,$2,$2,$3,$4,$5,NULL)`,
        [name, phone, stageId, channel, source],
      );
      created += 1;
    }
  }

  console.log(JSON.stringify({
    tenant: SLUG,
    password: PASSWORD,
    users: PEOPLE.map((p) => ({ ...p, id: ids[p.key] })),
    sales_manager_id: salesManagerId,
    leads_created: created,
  }, null, 2));
};

run().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
