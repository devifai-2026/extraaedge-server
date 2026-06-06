// Read-only: dump the leads soft-deleted by the phone-dedup migration
// (1700000052000_leads_unique_phone_guard) to a CSV for sanity review.
//
// For every normalised-phone group that had >1 live lead, the migration kept
// the EARLIEST and soft-deleted the rest. This script reconstructs each group
// and writes one CSV row per lead (survivor + merged-away duplicates) so a
// human can eyeball whether any "duplicates" are actually distinct people who
// happen to share a phone (e.g. family members).
//
// Usage:
//   node scripts/diag-reassign-dataloss.js [tenant-slug] [out.csv]
//
// Defaults: tenant-slug=speedup-infotech, out=merged-leads-review.csv
//
// A lead is included if it is currently soft-deleted AND its normalised phone
// still matches a live (kept) lead — i.e. it was merged away by the guard, not
// deleted for some unrelated reason. The kept survivor is included too, tagged
// role=kept, so each group reads as: one `kept` + N `merged` rows.
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery } from '../src/db/tenant.js';

const slug = process.argv[2] ?? 'speedup-infotech';
const outPath = process.argv[3] ?? 'merged-leads-review.csv';

const { rows: [tenant] } = await sysQuery(
  `SELECT id, slug, status, db_name, db_user, db_password_encrypted
     FROM tenants WHERE deleted_at IS NULL AND slug = $1`,
  [slug],
);
if (!tenant) {
  console.error(`Tenant "${slug}" not found.`);
  process.exit(1);
}

const PHONE_DIGITS = `right(regexp_replace(coalesce(l.phone,''), '\\D', '', 'g'), 10)`;

// Pull every lead (live OR soft-deleted) whose normalised phone belongs to a
// group that currently has exactly one live survivor AND at least one
// soft-deleted member — the signature of a guard merge. Ordered so each group
// is contiguous and the survivor sorts first.
const { rows } = await tenantQuery(tenant, `
  WITH norm AS (
    SELECT l.*, ${PHONE_DIGITS} AS phone10
      FROM leads l
     WHERE length(${PHONE_DIGITS}) = 10
  ),
  groups AS (
    SELECT phone10
      FROM norm
     GROUP BY phone10
    HAVING count(*) FILTER (WHERE deleted_at IS NULL) = 1
       AND count(*) FILTER (WHERE deleted_at IS NOT NULL) >= 1
  )
  SELECT n.phone10,
         CASE WHEN n.deleted_at IS NULL THEN 'kept' ELSE 'merged' END AS role,
         n.id, n.name, n.email, n.phone, n.whatsapp_number, n.alternate_contact,
         n.stage_id, st.name AS stage_name,
         n.assigned_to, u.name AS owner_name,
         n.created_by, cb.name AS created_by_name,
         n.created_at, n.deleted_at, n.lead_score
    FROM norm n
    JOIN groups g ON g.phone10 = n.phone10
    LEFT JOIN lead_stages st ON st.id = n.stage_id
    LEFT JOIN users u  ON u.id  = n.assigned_to
    LEFT JOIN users cb ON cb.id = n.created_by
   ORDER BY n.phone10, (n.deleted_at IS NOT NULL), n.created_at, n.id
`);

const COLUMNS = [
  'phone10', 'role', 'id', 'name', 'email', 'phone', 'whatsapp_number',
  'alternate_contact', 'stage_name', 'owner_name', 'created_by_name',
  'created_at', 'deleted_at', 'lead_score',
];

const csvCell = (v) => {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  // RFC-4180 quoting: wrap in quotes and double any embedded quotes if the
  // value contains a comma, quote, or newline.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const lines = [COLUMNS.join(',')];
for (const r of rows) lines.push(COLUMNS.map((c) => csvCell(r[c])).join(','));
writeFileSync(outPath, lines.join('\n') + '\n');

const merged = rows.filter((r) => r.role === 'merged').length;
const kept = rows.filter((r) => r.role === 'kept').length;
console.log(`[${tenant.slug}] wrote ${rows.length} rows to ${outPath}`);
console.log(`  groups (kept survivors) : ${kept}`);
console.log(`  merged-away duplicates  : ${merged}`);

await closeSystemPool();
