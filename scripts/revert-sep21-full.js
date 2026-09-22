// FULL revert of the 21 Sep 2026 bulk reassign by Abhijeet Salgar.
//
// Only his manual sweep is undone. SLA auto-reassignments are deliberately
// KEPT (user decision): they carry assigned_by = NULL so they can never match
// the filter, and any lead the SLA scanner moved AFTER his sweep no longer
// sits where he put it, so it is skipped by the `l.assigned_to = m.assigned_to`
// guard.
//
// SCOPE: revert iff (a) last assignment in the window was by Abhijeet,
// (b) the lead is STILL with whoever he gave it to, (c) the prior owner is
// active. (c) excludes the inactive "Divya Nair (Dummy TL)" account.
// Converted/deleted leads skipped. Stage is never touched.
//
// RESUMABLE + CRASH-TOLERANT. Two earlier runs died on "Connection terminated
// unexpectedly": the shared tenant pool has no 'error' listener, so a dropped
// idle client raises an unhandled event and kills the process before any
// try/catch runs. This version uses its OWN pool with an error handler, and
// batches each lead's four statements into one round-trip to cut ~12k
// sequential transactions down to a fraction of the wall time.
//
// Re-running is safe: completed leads no longer satisfy (b) and drop out of
// the candidate set automatically.
//
// Usage: node scripts/revert-sep21-full.js [--apply]
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import pg from 'pg';
import { sysQuery, closeSystemPool } from '../src/db/system.js';
import { env } from '../src/config/env.js';
import { decrypt } from '../src/lib/crypto.js';

const APPLY = process.argv.includes('--apply');
const OUT = 'sep21-revert-full.csv';
const WIN_FROM = '2026-09-20T18:00:00Z';
const WIN_TO   = '2026-09-21T06:00:00Z';
const REASON = 'revert 21 Sep bulk reassign (full): restore prior owner';
const BATCH = 25;

const { rows: [tenant] } = await sysQuery(
  `SELECT id, slug, status, db_name, db_user, db_password_encrypted
     FROM tenants WHERE slug = 'speedup-infotech' AND deleted_at IS NULL`);
if (!tenant) { console.error('tenant not found'); process.exit(1); }

// Own pool, with the error handler the shared one lacks.
const pool = new pg.Pool({
  host: env.TENANT_DB_HOST, port: env.TENANT_DB_PORT,
  database: tenant.db_name, user: tenant.db_user,
  password: decrypt(tenant.db_password_encrypted),
  ssl: env.TENANT_DB_SSL ? { rejectUnauthorized: false } : false,
  max: 4, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 15_000,
  keepAlive: true,
});
pool.on('error', (err) => console.log(`  [pool] recovered: ${err.message}`));

const q = async (text, params) => {
  for (let attempt = 1; ; attempt += 1) {
    try { return await pool.query(text, params); }
    catch (err) {
      if (attempt >= 6) throw err;
      console.log(`  [retry ${attempt}] ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
};

const { rows: cands } = await q(
  `WITH moved AS (
     SELECT DISTINCT ON (a.lead_id)
            a.lead_id, a.created_at AS moved_at, a.from_user_id, a.assigned_to
       FROM lead_assignments a JOIN users ab ON ab.id = a.assigned_by
      WHERE ab.name ILIKE '%Abhijeet%'
        AND a.created_at >= $1 AND a.created_at < $2
      ORDER BY a.lead_id, a.created_at DESC)
   SELECT m.lead_id, l.name AS lead_name, m.moved_at,
          m.from_user_id AS prior_owner, pu.name AS prior_owner_name,
          pu.is_active AS prior_active, pu.deleted_at IS NOT NULL AS prior_deleted,
          pu.manager_id AS prior_manager, pu.branch_id AS prior_branch,
          m.assigned_to AS current_owner, cu.name AS current_owner_name,
          COALESCE(st.name,'(none)') AS stage
     FROM moved m
     JOIN leads l ON l.id = m.lead_id
     LEFT JOIN users pu ON pu.id = m.from_user_id
     LEFT JOIN users cu ON cu.id = m.assigned_to
     LEFT JOIN lead_stages st ON st.id = l.stage_id
    WHERE l.deleted_at IS NULL AND l.converted_at IS NULL
      AND l.assigned_to = m.assigned_to
      AND m.from_user_id IS NOT NULL AND m.from_user_id <> m.assigned_to`,
  [WIN_FROM, WIN_TO]);

const revertable = [], held = [];
for (const c of cands) {
  if (c.prior_deleted || !c.prior_active) { held.push({ ...c, why: `prior owner inactive (${c.prior_owner_name})` }); continue; }
  revertable.push(c);
}
console.log(`Still displaced by the 21 Sep sweep : ${cands.length}`);
console.log(`  revertable (prior owner active)  : ${revertable.length}`);
console.log(`  held back                        : ${held.length}`);
const byWhy = {}; for (const h of held) byWhy[h.why] = (byWhy[h.why] ?? 0) + 1;
for (const [w, n] of Object.entries(byWhy)) console.log(`      ${n}\t${w}`);
const back = {}; for (const r of revertable) back[r.prior_owner_name] = (back[r.prior_owner_name] ?? 0) + 1;
console.log('\n  going back to:');
for (const [n, k] of Object.entries(back).sort((a,b)=>b[1]-a[1])) console.log(`      ${String(k).padStart(5)}  ${n}`);

writeFileSync(OUT, [
  'lead_id,lead_name,stage,from_owner,to_owner,action,note',
  ...revertable.map(r => [r.lead_id, JSON.stringify(r.lead_name ?? ''), JSON.stringify(r.stage),
    JSON.stringify(r.current_owner_name ?? ''), JSON.stringify(r.prior_owner_name ?? ''), 'REVERT', ''].join(',')),
  ...held.map(r => [r.lead_id, JSON.stringify(r.lead_name ?? ''), JSON.stringify(r.stage),
    JSON.stringify(r.current_owner_name ?? ''), JSON.stringify(r.prior_owner_name ?? ''), 'HELD', JSON.stringify(r.why)].join(',')),
].join('\n'));
console.log(`\nCSV written: ${OUT}`);

if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.'); await pool.end(); await closeSystemPool(); process.exit(0); }

// One round-trip per BATCH leads. Each statement re-checks assigned_to, so a
// lead moved by anyone else in the meantime is left alone.
let done = 0, failedBatches = 0;
// One transaction per chunk, statements sent individually on a dedicated
// client. Multi-statement strings cannot carry parameters in the extended
// query protocol ("cannot insert multiple commands into a prepared
// statement"), so batching is done by reusing ONE client across the chunk
// rather than by concatenating SQL.
for (let i = 0; i < revertable.length; i += BATCH) {
  const chunk = revertable.slice(i, i + BATCH);
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    for (const r of chunk) {
      // Guard: only act while the lead is still where the sweep left it.
      const { rows: [cur] } = await client.query(
        `SELECT assigned_to FROM leads WHERE id = $1 FOR UPDATE`, [r.lead_id]);
      if (!cur || cur.assigned_to !== r.current_owner) continue;
      await client.query(
        `UPDATE leads SET assigned_to=$2, manager_id=$3, branch_id=$4 WHERE id=$1`,
        [r.lead_id, r.prior_owner, r.prior_manager, r.prior_branch]);
      await client.query(
        `UPDATE lead_assignments SET is_active=false, status='closed'
          WHERE lead_id=$1 AND is_active=true`, [r.lead_id]);
      await client.query(
        `INSERT INTO lead_assignments (lead_id, from_user_id, assigned_to, assigned_by,
                                       assignment_type, reason, is_active, status)
         VALUES ($1,$2,$3,NULL,'reassign',$4,true,'open')`,
        [r.lead_id, r.current_owner, r.prior_owner, REASON]);
      await client.query(
        `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
         VALUES ($1,NULL,'reassign','Reverted 21 Sep bulk reassign — restored prior owner',$2::jsonb)`,
        [r.lead_id, JSON.stringify({ from: r.current_owner, to: r.prior_owner, source: 'revert-sep21-full' })]);
      done += 1;
    }
    await client.query('COMMIT');
  } catch (err) {
    failedBatches += 1;
    console.log(`  BATCH FAILED at ${i}: ${err.message}`);
    try { await client?.query('ROLLBACK'); } catch {}
  } finally {
    client?.release();
  }
  if (i % (BATCH * 20) === 0) console.log(`  ...${Math.min(i + BATCH, revertable.length)}/${revertable.length} (done=${done})`);
}
console.log(`\nAPPLIED. Reverted ${done}/${revertable.length}.${failedBatches ? ` ${failedBatches} batch(es) failed.` : ''}`);
console.log(`\nAPPLIED. Processed ${done}/${revertable.length}.`);
await pool.end();
await closeSystemPool();
