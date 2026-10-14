// Read-only diagnostic: dump every lead_followups row for a lead (by phone).
//
// Usage:
//   node scripts/diag-lead-followups.js <phone-substring> [tenant-slug]
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery } from '../src/db/tenant.js';

const needle = process.argv[2];
const slugFilter = process.argv[3] ?? null;
if (!needle) {
  console.error('Usage: node scripts/diag-lead-followups.js <phone-substring> [tenant-slug]');
  process.exit(1);
}
const digits = String(needle).replace(/\D+/g, '');

const { rows: tenants } = await sysQuery(
  `SELECT id, slug, status, db_name, db_user, db_password_encrypted
     FROM tenants
    WHERE deleted_at IS NULL ${slugFilter ? 'AND slug = $1' : ''}`,
  slugFilter ? [slugFilter] : [],
);

for (const tenant of tenants) {
  if (tenant.status !== 'active') continue;
  let leads;
  try {
    const r = await tenantQuery(
      tenant,
      `SELECT l.id, l.name, l.phone, l.stage_id, st.name AS stage_name
         FROM leads l
         LEFT JOIN lead_stages st ON st.id = l.stage_id
        WHERE l.deleted_at IS NULL
          AND (regexp_replace(COALESCE(l.phone,''),'\\D','','g') LIKE '%'||$1||'%'
            OR regexp_replace(COALESCE(l.whatsapp_number,''),'\\D','','g') LIKE '%'||$1||'%')`,
      [digits],
    );
    leads = r.rows;
  } catch (e) {
    continue;
  }
  if (!leads.length) continue;
  console.log(`\n=== tenant ${tenant.slug} ===`);
  for (const lead of leads) {
    console.log(`\nLEAD ${lead.id}  ${lead.name}  stage=${lead.stage_name} (${lead.stage_id})`);
    const { rows } = await tenantQuery(
      tenant,
      `SELECT id, next_action_datetime, status, slot_index, stage_id, sub_stage_id,
              left(coalesce(comment,''),40) AS comment,
              left(coalesce(completion_reason,''),40) AS closure,
              deleted_at, created_at
         FROM lead_followups
        WHERE lead_id = $1
        ORDER BY next_action_datetime ASC`,
      [lead.id],
    );
    console.log(`  total rows (incl deleted): ${rows.length}`);
    for (const f of rows) {
      console.log(
        `   ${String(f.next_action_datetime?.toISOString?.() ?? f.next_action_datetime).slice(0,16)}` +
        ` | status=${String(f.status).padEnd(9)} | slot=${f.slot_index === null ? 'NULL' : f.slot_index}` +
        ` | stage=${f.stage_id ?? 'NULL'} | del=${f.deleted_at ? 'Y' : 'n'} | "${f.comment}"`,
      );
    }
  }
}
await closeSystemPool();
