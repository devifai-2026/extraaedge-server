// Revert the 21 Sep 2026 bulk reassign, for leads left holding another
// user's OPEN follow-up.
//
// WHAT HAPPENED: on 21 Sep 2026 02:46-03:02 IST (20 Sep 21:16-21:32 UTC),
// Abhijeet Salgar (super_admin) bulk-reassigned 16,098 leads. leads.assigned_to
// moved but lead_followups did not, so open (planned/missed) follow-ups were
// stranded on leads now owned by someone who never wrote them — they then went
// overdue under the new owner's name.
//
// SCOPE: a lead is reverted iff
//   (a) its most recent assignment in the window was made by Abhijeet, AND
//   (b) it still carries a live follow-up of ANY status (planned, missed or
//       done) whose created_by is NOT the current owner, AND
//   (c) the owner it was taken from (from_user_id) is still is_active and not
//       deleted.
// (c) deliberately EXCLUDES the 131 leads whose prior owner is the inactive
// "Divya Nair (Dummy TL)" account — that account was what the bulk move was
// cleaning up, and reverting to it would undo intended work and park live
// follow-ups on an account nobody logs into. Those are reported, not touched.
//
// Leads that were reassigned again, converted or deleted after the window are
// skipped by construction (the guard is re-checked at write time inside the
// transaction, so a concurrent change cannot be clobbered).
//
// Writes are the same shape as every other assignment path: close the active
// lead_assignments row, append a new one, log a lead_activities row. NOTHING
// is deleted and the follow-up rows themselves are not modified.
//
// Usage:
//   node scripts/revert-sep21-bulk-reassign.js                 # dry run + CSV
//   node scripts/revert-sep21-bulk-reassign.js --apply         # perform writes
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { tenantQuery, tenantTx } from '../src/db/tenant.js';

const APPLY = process.argv.includes('--apply');
const OUT = 'sep21-revert-all.csv';
const WIN_FROM = '2026-09-20T18:00:00Z';
const WIN_TO   = '2026-09-21T06:00:00Z';

const { rows: [tenant] } = await sysQuery(
  `SELECT id, slug, status, db_name, db_user, db_password_encrypted
     FROM tenants WHERE slug = 'speedup-infotech' AND deleted_at IS NULL`);
if (!tenant) { console.error('tenant not found'); process.exit(1); }

// Candidates. `moved` takes each lead's LAST assignment inside the window, so
// a lead touched twice that night resolves to where it ended up.
const { rows: cands } = await tenantQuery(tenant,
  `WITH moved AS (
     SELECT DISTINCT ON (a.lead_id)
            a.lead_id, a.created_at AS moved_at, a.from_user_id, a.assigned_to
       FROM lead_assignments a
       JOIN users ab ON ab.id = a.assigned_by
      WHERE ab.name ILIKE '%Abhijeet%'
        AND a.created_at >= $1 AND a.created_at < $2
      ORDER BY a.lead_id, a.created_at DESC)
   SELECT m.lead_id, l.name AS lead_name, m.moved_at,
          m.from_user_id AS prior_owner, pu.name AS prior_owner_name,
          pu.is_active AS prior_active, pu.deleted_at IS NOT NULL AS prior_deleted,
          m.assigned_to AS current_owner, cu.name AS current_owner_name,
          l.assigned_to AS owner_now,
          count(f.id)::int AS open_followups
     FROM moved m
     JOIN leads l ON l.id = m.lead_id
     JOIN lead_followups f
       ON f.lead_id = m.lead_id AND f.deleted_at IS NULL
      AND f.created_by IS DISTINCT FROM m.assigned_to
     LEFT JOIN users pu ON pu.id = m.from_user_id
     LEFT JOIN users cu ON cu.id = m.assigned_to
    WHERE l.deleted_at IS NULL AND l.converted_at IS NULL
    GROUP BY m.lead_id, l.name, m.moved_at, m.from_user_id, pu.name, pu.is_active,
             pu.deleted_at, m.assigned_to, cu.name, l.assigned_to
    ORDER BY l.name`,
  [WIN_FROM, WIN_TO]);

// Split: revertable vs held back.
const revertable = [];
const held = [];
for (const c of cands) {
  if (!c.prior_owner)                        { held.push({ ...c, why: 'no prior owner' }); continue; }
  if (c.prior_deleted || !c.prior_active)    { held.push({ ...c, why: `prior owner inactive (${c.prior_owner_name})` }); continue; }
  if (c.owner_now !== c.current_owner)       { held.push({ ...c, why: 'owner changed since the window' }); continue; }
  if (c.prior_owner === c.current_owner)     { held.push({ ...c, why: 'already with prior owner' }); continue; }
  revertable.push(c);
}

console.log(`Candidates with stranded open follow-ups : ${cands.length}`);
console.log(`  revertable (prior owner still active)  : ${revertable.length}`);
console.log(`  held back                              : ${held.length}`);
const byWhy = {};
for (const h of held) byWhy[h.why] = (byWhy[h.why] ?? 0) + 1;
for (const [w, n] of Object.entries(byWhy).sort((a,b)=>b[1]-a[1])) console.log(`      ${n}\t${w}`);

const rows = [
  'lead_id,lead_name,open_followups,from_owner,to_owner,action,note',
  ...revertable.map(r => [r.lead_id, JSON.stringify(r.lead_name ?? ''), r.open_followups,
    JSON.stringify(r.current_owner_name ?? ''), JSON.stringify(r.prior_owner_name ?? ''), 'REVERT', ''].join(',')),
  ...held.map(r => [r.lead_id, JSON.stringify(r.lead_name ?? ''), r.open_followups,
    JSON.stringify(r.current_owner_name ?? ''), JSON.stringify(r.prior_owner_name ?? ''), 'HELD', JSON.stringify(r.why)].join(',')),
];
writeFileSync(OUT, rows.join('\n'));
console.log(`\nCSV written: ${OUT}`);

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to perform the revert.');
  await closeSystemPool();
  process.exit(0);
}

// Snap manager_id/branch_id to the restored owner, same as every other
// assignment path.
const meta = new Map();
for (const id of new Set(revertable.map(r => r.prior_owner))) {
  const { rows: [u] } = await tenantQuery(tenant, `SELECT manager_id, branch_id FROM users WHERE id = $1`, [id]);
  meta.set(id, { manager_id: u?.manager_id ?? null, branch_id: u?.branch_id ?? null });
}

let done = 0, skipped = 0;
for (const r of revertable) {
  const m = meta.get(r.prior_owner);
  // eslint-disable-next-line no-await-in-loop
  await tenantTx(tenant, async (client) => {
    // Re-check ownership inside the txn: if anything moved this lead between
    // the SELECT above and now, leave it alone rather than clobbering.
    const { rows: [cur] } = await client.query(
      `SELECT assigned_to FROM leads WHERE id = $1 FOR UPDATE`, [r.lead_id]);
    if (!cur || cur.assigned_to !== r.current_owner) { skipped += 1; return; }

    await client.query(
      `UPDATE leads SET assigned_to = $2, manager_id = $3, branch_id = $4 WHERE id = $1`,
      [r.lead_id, r.prior_owner, m.manager_id, m.branch_id]);
    await client.query(
      `UPDATE lead_assignments SET is_active = false, status = 'closed'
        WHERE lead_id = $1 AND is_active = true`, [r.lead_id]);
    await client.query(
      `INSERT INTO lead_assignments
         (lead_id, from_user_id, assigned_to, assigned_by, assignment_type, reason, is_active, status)
       VALUES ($1,$2,$3,NULL,'reassign','revert 21 Sep bulk reassign: restore prior owner',true,'open')`,
      [r.lead_id, r.current_owner, r.prior_owner]);
    await client.query(
      `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
       VALUES ($1, NULL, 'reassign', 'Reverted 21 Sep bulk reassign — restored prior owner', $2::jsonb)`,
      [r.lead_id, JSON.stringify({
        from: r.current_owner, to: r.prior_owner,
        source: 'revert-sep21-bulk-reassign', moved_at: r.moved_at,
      })]);
    done += 1;
  });
  if ((done + skipped) % 100 === 0) console.log(`  ...${done + skipped}/${revertable.length}`);
}
console.log(`\nAPPLIED. Reverted ${done} leads.${skipped ? ` Skipped ${skipped} (changed concurrently).` : ''}`);
console.log(`Held back ${held.length} — see ${OUT}.`);
await closeSystemPool();
