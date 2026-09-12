// E2E: staff leave on the demo tenant — apply, approve, balances, the
// configurable approval chain, and the guards that stop abuse.
import 'dotenv/config';
import { resolveTenantBySlug, tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { closeSystemPool } from '../src/db/system.js';
import { signAccessToken } from '../src/lib/jwt.js';

const BASE = 'http://localhost:4001/api/v1';
const t = await resolveTenantBySlug('demo');
let fail = 0;
const step = (n, ok, msg) => { if (!ok) fail += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}. ${msg}`); };

const u = async (email) => {
  const { rows: [x] } = await tenantQuery(t, `SELECT id, role, name, manager_id FROM users WHERE email=$1 AND deleted_at IS NULL`, [email]);
  return x;
};
const as = (x) => signAccessToken({ sub: x.id, tenantId: t.id, tenantSlug: 'demo', role: x.role, sessionId: 'leave', type: 'access' });
const api = async (x, path, opt = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...opt, headers: { authorization: `Bearer ${as(x)}`, 'content-type': 'application/json', ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data, error: j?.error };
};

const tc = await u('telecaller@demo.local');   // applicant; manager is the telecaller lead
const tl = await u('tl@demo.local');           // their lead
const sm = await u('sm@demo.local');
const hr = await u('hr@demo.local');
const admin = await u('bm@demo.local');

// clean slate
await tenantQuery(t, `DELETE FROM staff_leave WHERE reason LIKE 'zz-e2e%'`);

console.log('\n=== STAFF LEAVE (demo) ===\n');

// 1. types are seeded and readable by any employee
const types = await api(tc, '/staff-leave/types');
const cl = (types.data || []).find((x) => x.code === 'CL');
step(1, types.status === 200 && !!cl, `${(types.data || []).length} leave types available to a telecaller`);

// 2. balances show the seeded quota
const bal = await api(tc, '/staff-leave/mine/balances');
const clBal = (bal.data || []).find((b) => b.code === 'CL');
step(2, bal.status === 200 && Number(clBal?.available_days) === 12, `CL balance shows ${clBal?.available_days} available`);

// 3. the chain is visible BEFORE applying (lead_only by default)
const chain = await api(tc, '/staff-leave/mine/approval-chain');
step(3, chain.status === 200 && chain.data?.mode === 'lead_only' && chain.data?.steps?.length === 1,
  `chain resolves to ${chain.data?.mode} with ${chain.data?.steps?.length} step`);

// 4. apply
const applied = await api(tc, '/staff-leave', { method: 'POST', body: JSON.stringify({
  leave_type_id: cl.id, from_date: '2026-11-02', to_date: '2026-11-04', reason: 'zz-e2e casual',
}) });
step(4, applied.status === 201 && applied.data?.status === 'pending' && Number(applied.data?.day_count) === 3,
  `applied: status=${applied.data?.status} days=${applied.data?.day_count}`);
const leaveId = applied.data?.id;

// 5. pending is held against the balance so the same days can't be booked twice
const bal2 = await api(tc, '/staff-leave/mine/balances');
const clBal2 = (bal2.data || []).find((b) => b.code === 'CL');
step(5, Number(clBal2?.available_days) === 9, `pending request holds the days (available now ${clBal2?.available_days})`);

// 6. overlapping request is refused
const dup = await api(tc, '/staff-leave', { method: 'POST', body: JSON.stringify({
  leave_type_id: cl.id, from_date: '2026-11-03', to_date: '2026-11-05', reason: 'zz-e2e overlap',
}) });
step(6, dup.status === 409, `overlapping request refused (${dup.status})`);

// 7. the applicant cannot approve their own
const self = await api(tc, `/staff-leave/${leaveId}/decide`, { method: 'POST', body: JSON.stringify({ approve: true }) });
step(7, self.status >= 400, `self-approval blocked (${self.status})`);

// 8. an unrelated manager is not the approver
const wrong = await api(sm, `/staff-leave/${leaveId}/decide`, { method: 'POST', body: JSON.stringify({ approve: true }) });
step(8, wrong.status === 403, `a manager who is not in the chain is refused (${wrong.status})`);

// 9. it IS in the lead's queue
const queue = await api(tl, '/staff-leave/queue/pending');
step(9, queue.status === 200 && (queue.data || []).some((q) => q.leave_id === leaveId),
  `the request is in the lead's approval queue (${(queue.data || []).length} item(s))`);

// 10. the lead approves -> final
const ok = await api(tl, `/staff-leave/${leaveId}/decide`, { method: 'POST', body: JSON.stringify({ approve: true, note: 'fine' }) });
step(10, ok.status === 200 && ok.data?.final === true && ok.data?.status === 'approved', `lead approved, final=${ok.data?.final}`);

// 11. the balance is now consumed, not merely held
const bal3 = await api(tc, '/staff-leave/mine/balances');
const clBal3 = (bal3.data || []).find((b) => b.code === 'CL');
step(11, Number(clBal3?.used_days) === 3 && Number(clBal3?.available_days) === 9,
  `balance consumed: used=${clBal3?.used_days} available=${clBal3?.available_days}`);

// 12. switch the policy to two_level and confirm the chain grows
await api(admin, '/staff-leave/policies/telecaller', { method: 'PUT', body: JSON.stringify({ approval_mode: 'two_level' }) });
const chain2 = await api(tc, '/staff-leave/mine/approval-chain');
step(12, chain2.data?.mode === 'two_level' && chain2.data?.steps?.length === 2,
  `two_level chain resolves to ${chain2.data?.steps?.length} steps (lead then HR)`);

// 13. a two-level request needs BOTH
const two = await api(tc, '/staff-leave', { method: 'POST', body: JSON.stringify({
  leave_type_id: cl.id, from_date: '2026-12-01', to_date: '2026-12-01', reason: 'zz-e2e two level',
}) });
const twoId = two.data?.id;
const firstOk = await api(tl, `/staff-leave/${twoId}/decide`, { method: 'POST', body: JSON.stringify({ approve: true }) });
step(13, firstOk.data?.final === false && firstOk.data?.awaiting === 1,
  `after the lead approves it is still pending, awaiting ${firstOk.data?.awaiting} more`);

// 14. HR completes it
const secondOk = await api(hr, `/staff-leave/${twoId}/decide`, { method: 'POST', body: JSON.stringify({ approve: true }) });
step(14, secondOk.data?.final === true && secondOk.data?.status === 'approved', 'HR completes the chain -> approved');

// 15. holidays: a 3-day span becomes 3 rows
const hol = await api(admin, '/staff-leave/holidays', { method: 'POST', body: JSON.stringify({
  name: 'zz-e2e Ganesh Puja', from_date: '2026-09-25', to_date: '2026-09-27',
}) });
step(15, hol.status === 201 && (hol.data || []).length === 3, `a 3-day holiday span created ${(hol.data || []).length} rows`);

// 16. declining requires a note
const need = await api(tc, '/staff-leave', { method: 'POST', body: JSON.stringify({
  leave_type_id: cl.id, from_date: '2026-12-20', to_date: '2026-12-20', reason: 'zz-e2e decline',
}) });
const noNote = await api(tl, `/staff-leave/${need.data?.id}/decide`, { method: 'POST', body: JSON.stringify({ approve: false }) });
step(16, noNote.status === 400, `declining without a note is refused (${noNote.status})`);

// ---- cleanup --------------------------------------------------------------
await api(admin, '/staff-leave/policies/telecaller', { method: 'PUT', body: JSON.stringify({ approval_mode: 'lead_only' }) });
await tenantQuery(t, `DELETE FROM leave_ledger WHERE leave_id IN (SELECT id FROM staff_leave WHERE reason LIKE 'zz-e2e%')`);
await tenantQuery(t, `DELETE FROM staff_leave WHERE reason LIKE 'zz-e2e%'`);
await tenantQuery(t, `DELETE FROM leave_balances WHERE user_id = $1`, [tc.id]);
await tenantQuery(t, `DELETE FROM holidays WHERE name LIKE 'zz-e2e%'`);

console.log(`\n${fail === 0 ? 'ALL 16 STEPS PASSED' : fail + ' STEP(S) FAILED'} — cleaned up\n`);
await closeAllTenantPools(); await closeSystemPool();
process.exit(fail ? 1 : 0);
