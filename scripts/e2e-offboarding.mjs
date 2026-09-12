// E2E: offboarding handover, end to end on the demo tenant.
//
// Proves the thing that actually matters: a departing user's live work LANDS on
// the successor rather than being orphaned by a soft delete. Creates its own
// throwaway user, gives them real work, offboards them, then asserts the counts
// moved — and cleans up after itself.
import 'dotenv/config';
import argon2 from 'argon2';
import { resolveTenantBySlug, tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { closeSystemPool } from '../src/db/system.js';
import { signAccessToken } from '../src/lib/jwt.js';

const BASE = 'http://localhost:4001/api/v1';
const t = await resolveTenantBySlug('demo');
const ok = (c, m) => console.log(`  ${c ? 'PASS' : 'FAIL'}  ${m}`);
let failures = 0;
const expect = (c, m) => { if (!c) failures += 1; ok(c, m); };

const { rows: [admin] } = await tenantQuery(t,
  `SELECT id, email FROM users WHERE role='super_admin' AND deleted_at IS NULL LIMIT 1`);
const tok = signAccessToken({ sub: admin.id, tenantId: t.id, tenantSlug: 'demo', role: 'super_admin', sessionId: 'e2e', type: 'access' });
const api = (p, opt = {}) => fetch(`${BASE}${p}`, {
  ...opt,
  headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...(opt.headers || {}) },
});

// ---- setup: a throwaway counsellor holding real work ----------------------
const hash = await argon2.hash('ChangeMe123!', { type: argon2.argon2id, memoryCost: 1 << 16, timeCost: 3, parallelism: 1 });
const { rows: [role] } = await tenantQuery(t, `SELECT id FROM custom_roles WHERE scope='counsellor' AND deleted_at IS NULL LIMIT 1`);
const { rows: [branch] } = await tenantQuery(t, `SELECT id FROM branches WHERE deleted_at IS NULL LIMIT 1`);
const { rows: [sm] } = await tenantQuery(t, `SELECT id FROM users WHERE email='sm@demo.local'`);

await tenantQuery(t, `DELETE FROM users WHERE email='zz.leaver@demo.local'`);
const { rows: [leaver] } = await tenantQuery(t,
  `INSERT INTO users (name,email,password_hash,role,role_id,branch_id,manager_id,is_active)
   VALUES ('ZZ Leaver','zz.leaver@demo.local',$1,'counsellor',$2,$3,$4,true) RETURNING id`,
  [hash, role.id, branch?.id ?? null, sm?.id ?? null]);

// give them 4 leads + 2 planned follow-ups
const { rows: leads } = await tenantQuery(t,
  `UPDATE leads SET assigned_to=$1 WHERE id IN (
     SELECT id FROM leads WHERE deleted_at IS NULL AND converted_at IS NULL ORDER BY created_at LIMIT 4
   ) RETURNING id`, [leaver.id]);
for (const l of leads.slice(0, 2)) {
  await tenantQuery(t,
    `INSERT INTO lead_followups (lead_id,next_action_datetime,status,comment,created_by)
     VALUES ($1, now()+interval '2 days','planned','zz offboard test',$2)`, [l.id, leaver.id]);
}
console.log(`\nsetup: ZZ Leaver owns ${leads.length} leads + 2 planned follow-ups\n`);

// ---- 1. preview shows the blockers ---------------------------------------
const prev = await (await api(`/users/${leaver.id}/offboarding-preview`)).json();
const pw = prev?.data?.pending_work ?? [];
expect(pw.some((w) => w.key === 'open_leads' && w.count === 4), `preview reports 4 open leads (got ${pw.find((w) => w.key === 'open_leads')?.count})`);
expect(pw.some((w) => w.key === 'planned_followups' && w.count === 2), 'preview reports 2 planned follow-ups');
expect(prev?.data?.requires_reassignment === true, 'preview flags reassignment required');
expect((prev?.data?.candidates ?? []).every((c) => ['counsellor', 'telecaller', 'telecaller_lead'].includes(c.role)),
  'successor candidates are lead-owner roles only');

// ---- 2. delete WITHOUT a successor is refused -----------------------------
const bare = await api(`/users/${leaver.id}`, { method: 'DELETE', body: JSON.stringify({}) });
const bareJson = await bare.json().catch(() => ({}));
expect(bare.status === 409, `delete without successor refused (HTTP ${bare.status})`);
expect(bareJson?.error?.details?.requires === 'reassign_to', 'refusal names reassign_to as the fix');

// ---- 3. an INELIGIBLE successor is refused --------------------------------
const { rows: [trainer] } = await tenantQuery(t, `SELECT id FROM users WHERE email='trainer@demo.local'`);
const badRes = await api(`/users/${leaver.id}`, { method: 'DELETE', body: JSON.stringify({ reassign_to: trainer.id }) });
expect(badRes.status === 409, `handing leads to a trainer refused (HTTP ${badRes.status})`);

// ---- 4. the real offboard --------------------------------------------------
const { rows: [succ] } = await tenantQuery(t, `SELECT id,name FROM users WHERE email='counsellor@demo.local'`);
const before = await tenantQuery(t, `SELECT count(*) c FROM leads WHERE assigned_to=$1 AND deleted_at IS NULL AND converted_at IS NULL`, [succ.id]);
const del = await api(`/users/${leaver.id}`, { method: 'DELETE', body: JSON.stringify({ reassign_to: succ.id }) });
expect(del.status === 204, `offboard with a valid successor succeeds (HTTP ${del.status})`);

const after = await tenantQuery(t, `SELECT count(*) c FROM leads WHERE assigned_to=$1 AND deleted_at IS NULL AND converted_at IS NULL`, [succ.id]);
expect(Number(after.rows[0].c) - Number(before.rows[0].c) === 4, `successor gained the 4 leads (${before.rows[0].c} -> ${after.rows[0].c})`);

const { rows: [orphan] } = await tenantQuery(t, `SELECT count(*) c FROM leads WHERE assigned_to=$1 AND deleted_at IS NULL`, [leaver.id]);
expect(Number(orphan.c) === 0, `no leads left orphaned on the deleted user (${orphan.c})`);

const { rows: [fu] } = await tenantQuery(t, `SELECT count(*) c FROM lead_followups WHERE created_by=$1 AND status='planned' AND deleted_at IS NULL`, [leaver.id]);
expect(Number(fu.c) === 0, `no planned follow-ups left on the deleted user (${fu.c})`);

const { rows: [gone] } = await tenantQuery(t, `SELECT deleted_at FROM users WHERE id=$1`, [leaver.id]);
expect(gone?.deleted_at !== null, 'departing user is soft-deleted');

const { rows: [audit] } = await tenantQuery(t, `SELECT count(*) c FROM audit_log WHERE action='user.offboarded' AND entity_id=$1`, [leaver.id]);
expect(Number(audit.c) === 1, 'offboarding wrote an audit row');

// ---- cleanup ---------------------------------------------------------------
await tenantQuery(t, `DELETE FROM lead_followups WHERE comment='zz offboard test'`);
await tenantQuery(t, `DELETE FROM user_managers WHERE user_id=$1 OR manager_id=$1`, [leaver.id]);
await tenantQuery(t, `DELETE FROM audit_log WHERE entity_id=$1 AND action='user.offboarded'`, [leaver.id]);
await tenantQuery(t, `DELETE FROM users WHERE id=$1`, [leaver.id]);
console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'} — cleanup done\n`);

await closeAllTenantPools(); await closeSystemPool();
process.exit(failures ? 1 : 0);
