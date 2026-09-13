// E2E: course authority follows the user's role.
//
// The bug: authority over a course is read from course_trainers.role='head',
// but Switch Role only changed users.role. When two trainers swapped, the new
// head trainer could not manage their own courses and the demoted one kept the
// power. Live case: Shreeraj Mane (speedup-infotech).
import 'dotenv/config';
import { resolveTenantBySlug, tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { closeSystemPool } from '../src/db/system.js';
import { signAccessToken } from '../src/lib/jwt.js';
import * as usersService from '../src/modules/users/service.js';

const BASE = 'http://localhost:4001/api/v1';
const slug = process.argv[2] || 'speedup-infotech';
const t = await resolveTenantBySlug(slug);
let fail = 0;
const step = (n, ok, msg) => { if (!ok) fail += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}. ${msg}`); };
const as = (x) => signAccessToken({ sub: x.id, tenantId: t.id, tenantSlug: slug, role: x.role, sessionId: 'roster', type: 'access' });
const api = async (x, p, opt = {}) => {
  const r = await fetch(`${BASE}${p}`, { ...opt, headers: { authorization: `Bearer ${as(x)}`, 'content-type': 'application/json', ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data, error: j?.error };
};

console.log('\n1. No roster anywhere disagrees with users.role');
const drift = await tenantQuery(t, `
  SELECT us.name, us.role AS user_role, ct.role AS roster_role
    FROM course_trainers ct JOIN users us ON us.id = ct.user_id
   WHERE ct.deleted_at IS NULL AND us.deleted_at IS NULL
     AND us.role IN ('trainer','head_trainer')
     AND ct.role <> (CASE WHEN us.role='head_trainer' THEN 'head' ELSE 'trainer' END)`);
step(1, drift.rows.length === 0, `zero drifted roster rows (${drift.rows.length})`);

console.log('\n2. A head trainer can manage a course they are head of');
const { rows: [ht] } = await tenantQuery(t, `
  SELECT DISTINCT us.id, us.role, us.name FROM users us
    JOIN course_trainers ct ON ct.user_id = us.id AND ct.deleted_at IS NULL AND ct.role='head'
   WHERE us.role='head_trainer' AND us.deleted_at IS NULL LIMIT 1`);
if (!ht) { step(2, false, 'no head_trainer on any roster to test with'); }
else {
  const { rows: [prog] } = await tenantQuery(t, `
    SELECT program_id FROM course_trainers WHERE user_id=$1 AND role='head' AND deleted_at IS NULL LIMIT 1`, [ht.id]);
  const { rows: [victim] } = await tenantQuery(t, `
    SELECT id FROM users WHERE role='trainer' AND deleted_at IS NULL AND id <> $1 LIMIT 1`, [ht.id]);

  const add = await api(ht, `/courses/${prog.program_id}/trainers`, {
    method: 'POST', body: JSON.stringify({ user_id: victim.id, role: 'trainer' }),
  });
  step(2, add.status === 201, `${ht.name} (head_trainer) can add a trainer (${add.status}) ${add.error?.message || ''}`);

  const head = await api(ht, `/courses/${prog.program_id}/trainers`, {
    method: 'POST', body: JSON.stringify({ user_id: victim.id, role: 'head' }),
  });
  step(3, head.status === 403, `but still cannot appoint a course HEAD — admin only (${head.status})`);

  // Clean up the row we added, without disturbing a pre-existing binding.
  if (add.status === 201 && add.data?.id) {
    await tenantQuery(t, `DELETE FROM course_trainers WHERE id=$1`, [add.data.id]);
  }
}

console.log('\n3. Switching role now MOVES course authority with it');
// Build an isolated pair so the test never depends on live staff.
const { rows: [prog2] } = await tenantQuery(t, `SELECT id FROM programs WHERE deleted_at IS NULL LIMIT 1`);
const { rows: [roleTrainer] } = await tenantQuery(t, `SELECT id FROM custom_roles WHERE scope='trainer' AND deleted_at IS NULL LIMIT 1`);
const { rows: [roleHead] } = await tenantQuery(t, `SELECT id FROM custom_roles WHERE scope='head_trainer' AND deleted_at IS NULL LIMIT 1`);
const { rows: [admin] } = await tenantQuery(t, `SELECT id, role FROM users WHERE role='super_admin' AND deleted_at IS NULL LIMIT 1`);

const { rows: [tmp] } = await tenantQuery(t, `
  INSERT INTO users (name, email, phone, role, role_id, password_hash, is_active)
  VALUES ('zz-roster-test', 'zz.roster@test.local', '9000000123', 'trainer', $1, 'x', true)
  ON CONFLICT (email) DO UPDATE SET role='trainer', role_id=EXCLUDED.role_id, deleted_at=NULL
  RETURNING id`, [roleTrainer.id]);
await tenantQuery(t, `
  INSERT INTO course_trainers (program_id, user_id, role) VALUES ($1,$2,'trainer')
  ON CONFLICT DO NOTHING`, [prog2.id, tmp.id]);

await usersService.switchRole(t, tmp.id, { role_id: roleHead.id }, admin, {});
const { rows: [after] } = await tenantQuery(t, `
  SELECT role FROM course_trainers WHERE program_id=$1 AND user_id=$2 AND deleted_at IS NULL`, [prog2.id, tmp.id]);
step(4, after?.role === 'head', `promoting to head_trainer made them 'head' on their roster (${after?.role})`);

await usersService.switchRole(t, tmp.id, { role_id: roleTrainer.id }, admin, {});
const { rows: [back] } = await tenantQuery(t, `
  SELECT role FROM course_trainers WHERE program_id=$1 AND user_id=$2 AND deleted_at IS NULL`, [prog2.id, tmp.id]);
step(5, back?.role === 'trainer', `demoting back made them 'trainer' again (${back?.role})`);

await tenantQuery(t, `DELETE FROM course_trainers WHERE user_id=$1`, [tmp.id]);
await tenantQuery(t, `DELETE FROM user_managers WHERE user_id=$1 OR manager_id=$1`, [tmp.id]);
await tenantQuery(t, `DELETE FROM users WHERE id=$1`, [tmp.id]);

console.log('\n4. Branch manager can manage courses without being on the roster');
const { rows: [bm] } = await tenantQuery(t, `SELECT id, role, name FROM users WHERE role='branch_manager' AND deleted_at IS NULL LIMIT 1`);
const { rows: [anyProg] } = await tenantQuery(t, `SELECT id, name FROM programs WHERE deleted_at IS NULL LIMIT 1`);
const { rows: [onRoster] } = await tenantQuery(t,
  `SELECT 1 AS x FROM course_trainers WHERE program_id=$1 AND user_id=$2 AND deleted_at IS NULL`, [anyProg.id, bm.id]);
step(6, !onRoster, `the BM is NOT on this course's roster — so this tests org-wide reach`);

const bmList = await api(bm, '/courses');
step(7, bmList.status === 200 && (bmList.data || []).length > 0,
  `BM sees every course, not just their own (${bmList.status}, ${(bmList.data || []).length})`);

const { rows: [someTrainer] } = await tenantQuery(t, `SELECT id FROM users WHERE role='trainer' AND deleted_at IS NULL LIMIT 1`);
const bmAdd = await api(bm, `/courses/${anyProg.id}/trainers`, {
  method: 'POST', body: JSON.stringify({ user_id: someTrainer.id, role: 'trainer' }),
});
step(8, bmAdd.status === 201, `BM can add a trainer (${bmAdd.status}) ${bmAdd.error?.message || ''}`);
if (bmAdd.status === 201 && bmAdd.data?.id) {
  await tenantQuery(t, `DELETE FROM course_trainers WHERE id=$1`, [bmAdd.data.id]);
}

const bmMod = await api(bm, `/courses/${anyProg.id}/modules`, {
  method: 'POST', body: JSON.stringify({ name: 'zz-bm-module' }),
});
step(9, bmMod.status === 201, `BM can create a module (${bmMod.status}) ${bmMod.error?.message || ''}`);
if (bmMod.status === 201 && bmMod.data?.id) {
  await tenantQuery(t, `DELETE FROM course_modules WHERE id=$1`, [bmMod.data.id]);
}

console.log('\n5. The widening stops where it should');
// A plain trainer on a roster still cannot manage.
const { rows: [plainTrainer] } = await tenantQuery(t, `
  SELECT us.id, us.role FROM users us
    JOIN course_trainers ct ON ct.user_id = us.id AND ct.deleted_at IS NULL AND ct.role = 'trainer'
   WHERE us.role = 'trainer' AND us.deleted_at IS NULL LIMIT 1`);
if (plainTrainer) {
  const { rows: [tp] } = await tenantQuery(t,
    `SELECT program_id FROM course_trainers WHERE user_id=$1 AND role='trainer' AND deleted_at IS NULL LIMIT 1`, [plainTrainer.id]);
  const tMod = await api(plainTrainer, `/courses/${tp.program_id}/modules`, {
    method: 'POST', body: JSON.stringify({ name: 'zz-should-fail' }),
  });
  step(10, tMod.status === 403, `a plain trainer still cannot create a module (${tMod.status})`);
}
// A head_trainer gets no org-wide reach: a course they are not on stays closed.
const { rows: [htUser] } = await tenantQuery(t, `SELECT id, role FROM users WHERE role='head_trainer' AND deleted_at IS NULL LIMIT 1`);
const { rows: [foreign] } = await tenantQuery(t, `
  SELECT p.id FROM programs p
   WHERE p.deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM course_trainers ct
                      WHERE ct.program_id = p.id AND ct.user_id = $1 AND ct.deleted_at IS NULL)
   LIMIT 1`, [htUser?.id]);
if (htUser && foreign) {
  const hMod = await api(htUser, `/courses/${foreign.id}/modules`, {
    method: 'POST', body: JSON.stringify({ name: 'zz-should-fail' }),
  });
  step(11, hMod.status === 403, `a head trainer cannot manage a course they are NOT on (${hMod.status})`);
} else {
  console.log('  SKIP  11. no course exists that this head trainer is off');
}
// Appointing a course head stays admin-only.
if (htUser) {
  const { rows: [ownProg] } = await tenantQuery(t,
    `SELECT program_id FROM course_trainers WHERE user_id=$1 AND deleted_at IS NULL LIMIT 1`, [htUser.id]);
  if (ownProg) {
    const hHead = await api(htUser, `/courses/${ownProg.program_id}/trainers`, {
      method: 'POST', body: JSON.stringify({ user_id: someTrainer.id, role: 'head' }),
    });
    step(12, hHead.status === 403, `a head trainer still cannot appoint a course head (${hHead.status})`);
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nall green');
await closeAllTenantPools(); await closeSystemPool();
process.exit(fail ? 1 : 0);
