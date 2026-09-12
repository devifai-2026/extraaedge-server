// E2E: payroll on the demo tenant, end to end.
//
// The case from the brief: a trainer teaches 3 extra classes at 500 and the
// payslip shows 1500 — but only for classes the trainer actually MARKED
// COMPLETE. That link is the whole point of the completion flow.
import 'dotenv/config';
import { resolveTenantBySlug, tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { closeSystemPool } from '../src/db/system.js';
import { signAccessToken } from '../src/lib/jwt.js';

const BASE = 'http://localhost:4001/api/v1';
const t = await resolveTenantBySlug('demo');
let fail = 0;
const step = (n, ok, msg) => { if (!ok) fail += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}. ${msg}`); };

const u = async (email) => {
  const { rows: [x] } = await tenantQuery(t, `SELECT id, role, name FROM users WHERE email=$1 AND deleted_at IS NULL`, [email]);
  return x;
};
const as = (x) => signAccessToken({ sub: x.id, tenantId: t.id, tenantSlug: 'demo', role: x.role, sessionId: 'pay', type: 'access' });
const api = async (x, path, opt = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...opt, headers: { authorization: `Bearer ${as(x)}`, 'content-type': 'application/json', ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data, error: j?.error };
};

const admin = await u('admin@demo.local');
const hrLead = await u('hrlead@demo.local');
const trainer = await u('trainer@demo.local');
const tc = await u('telecaller@demo.local');

const YEAR = 2026; const MONTH = 7;   // July 2026 — no real demo data in it
const FROM = `${YEAR}-0${MONTH}-01`;

const clean = async () => {
  await tenantQuery(t, `DELETE FROM payroll_reminders WHERE run_id IN (SELECT id FROM payroll_runs WHERE period_year=$1 AND period_month=$2)`, [YEAR, MONTH]);
  await tenantQuery(t, `DELETE FROM payroll_disbursements WHERE run_id IN (SELECT id FROM payroll_runs WHERE period_year=$1 AND period_month=$2)`, [YEAR, MONTH]);
  await tenantQuery(t, `DELETE FROM payslips WHERE period_year=$1 AND period_month=$2`, [YEAR, MONTH]);
  await tenantQuery(t, `DELETE FROM payroll_runs WHERE period_year=$1 AND period_month=$2`, [YEAR, MONTH]);
  await tenantQuery(t, `DELETE FROM classes WHERE title LIKE 'zz-pay%'`);
};
await clean();

console.log('\n1. Access: salary is a per-row rule, not a tab');
const denied = await api(trainer, '/payroll/runs');
step(1, denied.status === 403, `a trainer cannot list payroll runs (${denied.status})`);
const mine = await api(trainer, '/payroll/my/payslips');
step(2, mine.status === 200, `but CAN see their own payslips (${mine.status})`);
const sm = await u('sm@demo.local');
const smDenied = await api(sm, `/payroll/structures/${trainer.id}`);
step(3, smDenied.status === 403, `a line manager cannot read a report's salary (${smDenied.status})`);

console.log("\n2. The trainer's classes — only COMPLETED ones pay");
const { rows: [batch] } = await tenantQuery(t, `SELECT id, program_id FROM batches WHERE deleted_at IS NULL LIMIT 1`);
const mk = async (title, endsAt) => {
  const { rows: [c] } = await tenantQuery(t,
    `INSERT INTO classes (program_id, batch_id, trainer_id, title, kind, mode, starts_at, ends_at, is_billable, completion_status, completion_due_at)
     VALUES ($1,$2,$3,$4,'lecture','online',$5::timestamptz - interval '1 hour',$5::timestamptz,true,'pending',$5::timestamptz + interval '24 hours')
     RETURNING id`, [batch.program_id, batch.id, trainer.id, title, endsAt]);
  return c.id;
};
const c1 = await mk('zz-pay extra 1', `${YEAR}-07-06 11:00+05:30`);
const c2 = await mk('zz-pay extra 2', `${YEAR}-07-13 11:00+05:30`);
const c3 = await mk('zz-pay extra 3', `${YEAR}-07-20 11:00+05:30`);
const c4 = await mk('zz-pay never confirmed', `${YEAR}-07-27 11:00+05:30`);

for (const id of [c1, c2, c3]) {
  const r = await api(trainer, `/classes/${id}/completion`, { method: 'POST', body: JSON.stringify({ status: 'completed' }) });
  if (r.status !== 200) step('2x', false, `mark complete failed: ${r.status} ${JSON.stringify(r.error)}`);
}
const { rows: [done] } = await tenantQuery(t, `SELECT count(*)::int n FROM classes WHERE title LIKE 'zz-pay%' AND completion_status='completed'`);
step(4, done.n === 3, `trainer marked 3 of 4 classes complete (${done.n})`);

const billErr = await api(trainer, `/classes/${c4}/completion`, { method: 'POST', body: JSON.stringify({ status: 'completed', is_billable: true }) });
step(5, billErr.status === 403, `a trainer cannot set is_billable themselves — that is a pay decision (${billErr.status})`);

console.log('\n3. Compute the run');
const run = await api(hrLead, '/payroll/runs', { method: 'POST', body: JSON.stringify({ period_year: YEAR, period_month: MONTH }) });
step(6, run.status === 201 && run.data?.id, `HR lead created the run (${run.status})`);
step(7, !!run.data?.pay_date, `pay date defaulted from tenant policy (${run.data?.pay_date})`);

const dup = await api(hrLead, '/payroll/runs', { method: 'POST', body: JSON.stringify({ period_year: YEAR, period_month: MONTH }) });
step(8, dup.status === 409, `a second run for the same month is refused (${dup.status})`);

const comp = await api(hrLead, `/payroll/runs/${run.data.id}/compute`, { method: 'POST' });
step(9, comp.status === 200, `computed (${comp.status}) — ${comp.data?.employee_count} employees, net ${comp.data?.total_net}`);

const slips = await api(hrLead, `/payroll/runs/${run.data.id}/payslips`);
const tSlip = (slips.data || []).find((s) => s.user_id === trainer.id);
step(10, !!tSlip, `the trainer has a payslip`);

const extra = (tSlip?.components || []).find((c) => c.code === 'EXTRA_CLASS');
step(11, extra && Number(extra.units) === 3, `EXTRA_CLASS counted 3 units, not 4 — the unconfirmed class does not pay (${extra?.units})`);
step(12, extra && Number(extra.amount) === 1500, `3 extra classes x 500 = 1500 (got ${extra?.amount})`);

const basic = (tSlip?.components || []).find((c) => c.code === 'BASIC');
const hra = (tSlip?.components || []).find((c) => c.code === 'HRA');
step(13, Number(basic?.amount) === 40000, `basic 40000 (${basic?.amount})`);
step(14, Number(hra?.amount) === 16000, `HRA = 40% of basic = 16000 (${hra?.amount})`);

const sum = (tSlip.components || []).filter((c) => c.kind === 'earning').reduce((a, c) => a + Number(c.amount), 0);
step(15, Math.abs(sum - Number(tSlip.gross_earnings)) < 0.01, `gross equals the sum of its earning lines (${sum} vs ${tSlip.gross_earnings})`);
step(16, Math.abs((Number(tSlip.gross_earnings) - Number(tSlip.total_deductions)) - Number(tSlip.net_pay)) < 0.01,
  `net = gross - deductions (${tSlip.net_pay})`);

console.log('\n4. The 24h sweep closes what nobody confirmed');
await tenantQuery(t, `UPDATE classes SET completion_due_at = now() - interval '1 hour' WHERE id = $1`, [c4]);
const { default: sweep } = await import('../src/workers/class-completion-sweeper.js');
await sweep();
const { rows: [swept] } = await tenantQuery(t, `SELECT completion_status, auto_marked_at FROM classes WHERE id=$1`, [c4]);
step(17, swept.completion_status === 'not_conducted' && !!swept.auto_marked_at,
  `the unconfirmed class was auto-marked not conducted (${swept.completion_status})`);

console.log('\n5. A branch manager can override the system');
const bm = await u('bm@demo.local');
const ov = await api(bm, `/classes/${c4}/completion`, { method: 'POST', body: JSON.stringify({ status: 'completed', note: 'zz-pay BM says it ran', is_billable: true }) });
step(18, ov.status === 200, `BM overrode the auto-mark (${ov.status})`);
const { rows: [after] } = await tenantQuery(t, `SELECT completion_status, override_by, auto_marked_at FROM classes WHERE id=$1`, [c4]);
step(19, after.completion_status === 'completed' && after.override_by === bm.id && !after.auto_marked_at,
  `recorded as a human override, not a system decision`);
const trainerReverse = await api(trainer, `/classes/${c4}/completion`, { method: 'POST', body: JSON.stringify({ status: 'not_conducted' }) });
step(20, trainerReverse.status === 403, `the trainer cannot reverse a decided class (${trainerReverse.status})`);

console.log('\n6. Recompute picks up the override');
const rc = await api(hrLead, `/payroll/runs/${run.data.id}/compute`, { method: 'POST' });
step('20b', rc.status === 200, `a run in REVIEW can still be recomputed — that is what review is for (${rc.status})`);
const slips2 = await api(hrLead, `/payroll/runs/${run.data.id}/payslips`);
const t2 = (slips2.data || []).find((s) => s.user_id === trainer.id);
const extra2 = (t2?.components || []).find((c) => c.code === 'EXTRA_CLASS');
step(21, Number(extra2?.units) === 4 && Number(extra2?.amount) === 2000, `now 4 classes = 2000 (${extra2?.amount})`);

console.log('\n7. Loss of pay flows from leave into the payslip');
const { rows: [cl] } = await tenantQuery(t, `SELECT id FROM leave_types WHERE code='CL' AND deleted_at IS NULL LIMIT 1`);
const { rows: [lv] } = await tenantQuery(t,
  `INSERT INTO staff_leave (user_id, leave_type_id, from_date, to_date, day_count, status, is_lop, lop_days, reason)
   VALUES ($1,$2,$3::date,$4::date,2,'approved',true,2,'zz-pay lop') RETURNING id`,
  [tc.id, cl.id, `${YEAR}-07-08`, `${YEAR}-07-09`]);
const rc2 = await api(hrLead, `/payroll/runs/${run.data.id}/compute`, { method: 'POST' });
step('21b', rc2.status === 200, `recompute after the leave was approved (${rc2.status})`);
const slips3 = await api(hrLead, `/payroll/runs/${run.data.id}/payslips`);
const tcSlip = (slips3.data || []).find((s) => s.user_id === tc.id);
step(22, Number(tcSlip?.lop_days) === 2, `2 unpaid days reached the payslip (${tcSlip?.lop_days})`);
const tcBasic = (tcSlip?.components || []).find((c) => c.code === 'BASIC');
step(23, Number(tcBasic?.amount) < 25000, `basic was pro-rated below the full 25000 (${tcBasic?.amount})`);

console.log('\n8. Approve, then disburse — segregation of duties');
const appr = await api(hrLead, `/payroll/runs/${run.data.id}/approve`, { method: 'POST' });
step(24, appr.status === 200 && appr.data?.status === 'approved', `HR lead approved the run (${appr.data?.status})`);
const recomp = await api(hrLead, `/payroll/runs/${run.data.id}/compute`, { method: 'POST' });
step(25, recomp.status === 409, `an approved run can no longer be recomputed (${recomp.status})`);

const { rows: [rem] } = await tenantQuery(t, `SELECT count(*)::int n FROM payroll_reminders WHERE run_id=$1`, [run.data.id]);
step(26, rem.n === 3, `3 salary reminders scheduled from the tenant's offsets (${rem.n})`);

const disb = await api(hrLead, `/payroll/runs/${run.data.id}/disbursements`);
step(27, disb.status === 200 && disb.data?.progress?.total > 0, `disbursement rows opened (${disb.data?.progress?.total})`);

const rows = disb.data.rows.filter((r) => r.disbursement_id);
const hrTriesToPay = await api(hrLead, `/payroll/disbursements/${rows[0].disbursement_id}/mark-paid`, { method: 'POST', body: JSON.stringify({ reference_no: 'zz' }) });
step(28, hrTriesToPay.status === 403, `the HR lead who COMPUTED payroll cannot also pay it (${hrTriesToPay.status})`);

let completedFlags = 0;
for (const r of rows) {
  const p = await api(admin, `/payroll/disbursements/${r.disbursement_id}/mark-paid`, { method: 'POST', body: JSON.stringify({ reference_no: `zz-${r.disbursement_id.slice(0, 6)}` }) });
  if (p.data?.completed) completedFlags += 1;
}
step(29, completedFlags === 1, `"everyone is paid" fired EXACTLY once (${completedFlags})`);
const { rows: [fin] } = await tenantQuery(t, `SELECT status, paid_count, completed_notified_at FROM payroll_runs WHERE id=$1`, [run.data.id]);
step(30, fin.status === 'paid' && !!fin.completed_notified_at, `run closed as paid (${fin.status}, ${fin.paid_count} paid)`);

const dbl = await api(admin, `/payroll/disbursements/${rows[0].disbursement_id}/mark-paid`, { method: 'POST', body: JSON.stringify({}) });
step(31, dbl.status === 409, `paying the same person twice is refused (${dbl.status})`);

console.log('\n9. The employee can now see their own payslip');
const myNow = await api(trainer, '/payroll/my/payslips');
const visible = (myNow.data || []).find((s) => s.period_month === MONTH && s.period_year === YEAR);
step(32, !!visible, `the trainer sees their published payslip`);
step(33, Number(visible?.net_pay) === Number(t2?.net_pay), `and it is the same net the run computed (${visible?.net_pay})`);

await tenantQuery(t, `DELETE FROM staff_leave WHERE id=$1`, [lv.id]);
await clean();
console.log(fail ? `\n${fail} FAILED` : '\nall green');
await closeAllTenantPools(); await closeSystemPool();
process.exit(fail ? 1 : 0);
