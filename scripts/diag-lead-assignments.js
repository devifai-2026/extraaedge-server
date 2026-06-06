// Read-only diagnostic: investigate duplicate leads by phone.
//
// Usage:
//   node scripts/diag-lead-assignments.js <phone-substring> [tenant-slug]
//
// Example:
//   node scripts/diag-lead-assignments.js 9322994226 speedup-infotech
//
// For each lead whose phone/whatsapp/alternate_contact matches the given
// digits, prints id, name, contact fields, owner, stage, created_by/at, and
// any bulk_import_duplicates row that references it. This tells us whether a
// pair of duplicates came in via the same bulk import (phone-skipped dedup)
// vs. manual create.
import 'dotenv/config';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery } from '../src/db/tenant.js';

const needle = process.argv[2];
const slugFilter = process.argv[3] ?? null;
if (!needle) {
  console.error('Usage: node scripts/diag-lead-assignments.js <phone-substring> [tenant-slug]');
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
      `SELECT l.id, l.name, l.email, l.phone, l.whatsapp_number, l.alternate_contact,
              l.stage_id, st.name AS stage_name,
              l.assigned_to, u.name AS owner_name,
              l.created_by, cb.name AS created_by_name, cb.role AS created_by_role,
              l.created_at, l.deleted_at
         FROM leads l
         LEFT JOIN lead_stages st ON st.id = l.stage_id
         LEFT JOIN users u  ON u.id  = l.assigned_to
         LEFT JOIN users cb ON cb.id = l.created_by
        WHERE regexp_replace(coalesce(l.phone,''),           '\\D', '', 'g') ILIKE $1
           OR regexp_replace(coalesce(l.whatsapp_number,''), '\\D', '', 'g') ILIKE $1
           OR regexp_replace(coalesce(l.alternate_contact,''),'\\D', '', 'g') ILIKE $1
        ORDER BY l.created_at`,
      [`%${digits}%`],
    );
    leads = r.rows;
  } catch (err) {
    // tenant DB may not have one of these columns/tables — skip quietly.
    continue;
  }
  if (!leads.length) continue;

  console.log(`\n=== [${tenant.slug}] ${leads.length} lead(s) matching "${digits}" ===`);
  for (const l of leads) {
    console.log(
      `\n  lead ${l.id}` +
      `\n    name=${l.name} email=${l.email ?? '∅'} ` +
      `phone=${l.phone ?? '∅'} whatsapp=${l.whatsapp_number ?? '∅'} alt=${l.alternate_contact ?? '∅'}` +
      `\n    stage=${l.stage_name ?? '∅'} owner=${l.owner_name ?? '∅'} deleted=${l.deleted_at ? 'YES' : 'no'}` +
      `\n    created_by=${l.created_by_name ?? '∅'} (${l.created_by_role ?? '?'}) at ${l.created_at?.toISOString?.() ?? l.created_at}`,
    );

    // Any bulk_import_duplicates rows referencing this lead as the matched lead?
    try {
      const { rows: dups } = await tenantQuery(
        tenant,
        `SELECT bid.import_id, bid.row_number, bid.match_field, bid.match_value,
                bid.resolution, bi.user_id AS import_user, bi.created_at AS import_created_at
           FROM bulk_import_duplicates bid
           LEFT JOIN bulk_imports bi ON bi.id = bid.import_id
          WHERE bid.matched_lead_id = $1`,
        [l.id],
      );
      for (const d of dups) {
        console.log(
          `    ↳ bulk_import_duplicate: import=${d.import_id} row=${d.row_number} ` +
          `field=${d.match_field} resolution=${d.resolution}`,
        );
      }
    } catch { /* table may not exist on older tenants */ }
  }

  // Summary: were any of these created in the same bulk import window / by the
  // same uploader within a short interval (heuristic for "same upload")?
  const byCreator = {};
  for (const l of leads) {
    const key = l.created_by ?? 'null';
    (byCreator[key] ??= []).push(l);
  }
  for (const [creator, group] of Object.entries(byCreator)) {
    if (group.length > 1) {
      console.log(
        `\n  ⚠ ${group.length} leads share created_by=${creator} ` +
        `(${group[0].created_by_name ?? 'unknown'}) — likely same upload/source`,
      );
    }
  }
}

await closeSystemPool();
