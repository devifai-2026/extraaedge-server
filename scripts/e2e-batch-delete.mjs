// E2E: deleting a batch, and refusing to when anything is attached.
//
// An empty batch (wrong name, wrong course) should be removable by the head
// trainer. A batch holding students or classes must NOT be, or attendance,
// recordings and payroll history are orphaned.
import 'dotenv/config';
import { resolveTenantBySlug, tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { closeSystemPool } from '../src/db/system.js';
import { signAccessToken } from '../src/lib/jwt.js';

const BASE = 'http://localhost:4001/api/v1';
const t = await resolveTenantBySlug('demo');
let fail = 0;
const step = (n, ok, msg) => { if (!ok) fail += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}. ${msg}`); };
const as = (x) => signAccessToken({ sub: x.id, tenantId: t.id, tenantSlug: 'demo', role: x.role, sessionId: 'bd', type: 'access' });
const api = async (x, p, opt = {}) => {
  const r = await fetch(`${BASE}${p}`, { ...opt, headers: { authorization: `Bearer ${as(x)}`, 'content-type': 'application/json', ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data, error: j?.error };
};

// A head trainer and a course they actually head.
const { rows: [ht] } = await tenantQuery(t, `
  SELECT DISTINCT us.id, us.role, us.name FROM users us
    JOIN course_trainers ct ON ct.user_id = us.id AND ct.deleted_at IS NULL AND ct.role='head'
   WHERE us.role='head_trainer' AND us.deleted_at IS NULL LIMIT 1`);
const { rows: [prog] } = await tenantQuery(t, `
  SELECT program_id FROM course_trainers WHERE user_id=$1 AND role='head' AND deleted_at IS NULL LIMIT 1`, [ht.id]);
const programId = prog.program_id;

await tenantQuery(t, `DELETE FROM batches WHERE name LIKE 'zz-del%'`);

console.log('\n1. An EMPTY batch can be deleted by the head trainer');
const mk = await api(ht, `/courses/${programId}/batches`, { method: 'POST', body: JSON.stringify({ name: 'zz-del empty' }) });
step(1, mk.status === 201 || mk.status === 200, `created a batch (${mk.status})`);
const emptyId = mk.data.id;

const usage = await api(ht, `/courses/${programId}/batches/${emptyId}/usage`);
step(2, usage.status === 200 && usage.data?.deletable === true, `usage says deletable (${JSON.stringify(usage.data)})`);

const del = await api(ht, `/courses/${programId}/batches/${emptyId}`, { method: 'DELETE' });
step(3, del.status === 200, `deleted (${del.status}) ${del.error?.message || ''}`);
const { rows: [gone] } = await tenantQuery(t, `SELECT deleted_at FROM batches WHERE id=$1`, [emptyId]);
step(4, !!gone.deleted_at, `soft-deleted — the row survives for audit`);
const list = await api(ht, `/courses/${programId}/batches`);
step(5, !(list.data || []).some((b) => b.id === emptyId), `gone from the batch list`);

console.log('\n2. A batch WITH STUDENTS is refused');
const mk2 = await api(ht, `/courses/${programId}/batches`, { method: 'POST', body: JSON.stringify({ name: 'zz-del with-student' }) });
const busyId = mk2.data.id;
const { rows: [student] } = await tenantQuery(t, `SELECT id FROM students WHERE deleted_at IS NULL LIMIT 1`);
await tenantQuery(t, `INSERT INTO batch_students (batch_id, student_id) VALUES ($1,$2)`, [busyId, student.id]);

const u2 = await api(ht, `/courses/${programId}/batches/${busyId}/usage`);
step(6, u2.data?.students === 1 && u2.data?.deletable === false, `usage reports 1 student, not deletable`);
const del2 = await api(ht, `/courses/${programId}/batches/${busyId}`, { method: 'DELETE' });
step(7, del2.status === 409, `delete refused with 409 (${del2.status})`);
step(8, /student/i.test(del2.error?.message || ''), `and the message names the blocker: "${del2.error?.message}"`);
const { rows: [still] } = await tenantQuery(t, `SELECT deleted_at FROM batches WHERE id=$1`, [busyId]);
step(9, !still.deleted_at, `the batch is untouched`);

console.log('\n3. A batch with CLASSES is refused (classes feed payroll)');
await tenantQuery(t, `DELETE FROM batch_students WHERE batch_id=$1`, [busyId]);
const { rows: [anyTrainer] } = await tenantQuery(t, `SELECT id FROM users WHERE role='trainer' AND deleted_at IS NULL LIMIT 1`);
await tenantQuery(t, `INSERT INTO classes (program_id, batch_id, trainer_id, title, kind, mode, starts_at, ends_at)
  VALUES ($1,$2,$3,'zz-del class','lecture','online', now(), now() + interval '1 hour')`, [programId, busyId, anyTrainer.id]);
const del3 = await api(ht, `/courses/${programId}/batches/${busyId}`, { method: 'DELETE' });
step(10, del3.status === 409 && /class/i.test(del3.error?.message || ''), `refused: "${del3.error?.message}"`);

console.log('\n4. Authority is enforced');
const { rows: [plain] } = await tenantQuery(t, `SELECT id, role FROM users WHERE role='trainer' AND deleted_at IS NULL LIMIT 1`);
const mk3 = await api(ht, `/courses/${programId}/batches`, { method: 'POST', body: JSON.stringify({ name: 'zz-del auth' }) });
const authId = mk3.data.id;
const denied = await api(plain, `/courses/${programId}/batches/${authId}`, { method: 'DELETE' });
step(11, denied.status === 403, `a plain trainer cannot delete a batch (${denied.status})`);
const { rows: [bm] } = await tenantQuery(t, `SELECT id, role FROM users WHERE role='branch_manager' AND deleted_at IS NULL LIMIT 1`);
const bmDel = await api(bm, `/courses/${programId}/batches/${authId}`, { method: 'DELETE' });
step(12, bmDel.status === 200, `a branch manager can (${bmDel.status})`);

// cleanup
await tenantQuery(t, `DELETE FROM classes WHERE title LIKE 'zz-del%'`);
await tenantQuery(t, `DELETE FROM batch_students WHERE batch_id IN (SELECT id FROM batches WHERE name LIKE 'zz-del%')`);
await tenantQuery(t, `DELETE FROM batches WHERE name LIKE 'zz-del%'`);

console.log(fail ? `\n${fail} FAILED` : '\nall green');
await closeAllTenantPools(); await closeSystemPool();
process.exit(fail ? 1 : 0);
