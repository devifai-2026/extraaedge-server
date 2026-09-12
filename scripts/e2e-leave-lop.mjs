// E2E: half-day leave and loss-of-pay decided at APPROVAL time.
//
// Proves the money path: an approver can approve an absence but mark some or
// all of it unpaid, those days do NOT also burn paid quota, and payroll can
// read the result back per month.
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
const as = (x) => signAccessToken({ sub: x.id, tenantId: t.id, tenantSlug: 'demo', role: x.role, sessionId: 'lop', type: 'access' });
const api = async (x, path, opt = {}) => {
  const r = await fetch(`${BASE}${path}`, { ...opt, headers: { authorization: `Bearer ${as(x)}`, 'content-type': 'application/json', ...(opt.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data, error: j?.error };
};

const tc = await u('telecaller@demo.local');
const tl = await u('tl@demo.local');
const hr = await u('hr@demo.local');

// Cleanup must also REVERSE what the ledger charged. Deleting the leave rows
// alone leaves used_days inflated, so every re-run silently ate a day or two of
// the demo user's quota (observed: 10 -> 8 -> 6 across runs).
const clean = async () => {
  await tenantQuery(t, `
    UPDATE leave_balances b
       SET used_days = GREATEST(0, b.used_days - x.charged), updated_at = now()
      FROM (
        SELECT l.user_id, l.leave_type_id,
               EXTRACT(YEAR FROM l.from_date)::int AS yr,
               COALESCE(SUM(g.delta_days), 0) AS charged
          FROM staff_leave l
          JOIN leave_ledger g ON g.leave_id = l.id
         WHERE l.reason LIKE 'zz-lop%'
         GROUP BY 1,2,3
      ) x
     WHERE b.user_id = x.user_id AND b.leave_type_id = x.leave_type_id
       AND b.period_year = x.yr`);
  await tenantQuery(t, `DELETE FROM leave_ledger WHERE leave_id IN (SELECT id FROM staff_leave WHERE reason LIKE 'zz-lop%')`);
  await tenantQuery(t, `DELETE FROM leave_approvals WHERE leave_id IN (SELECT id FROM staff_leave WHERE reason LIKE 'zz-lop%')`);
  await tenantQuery(t, `DELETE FROM staff_leave WHERE reason LIKE 'zz-lop%'`);
};
await clean();

// Use a paid type so LOP is genuinely the approver's override, not the type's.
const { rows: [cl] } = await tenantQuery(t, `SELECT id, code, allow_half_day, is_paid FROM leave_types WHERE code='CL' AND deleted_at IS NULL LIMIT 1`);
step(0, !!cl && cl.is_paid, `CL exists and is a PAID type (so LOP must come from the approver)`);

// Make the chain single-step so one decide() finalises it.
await api(hr, `/staff-leave/policies/${tc.role}`, { method: 'PUT', body: JSON.stringify({ approval_mode: 'lead_only' }) });

const balOf = async () => {
  const r = await api(tc, '/staff-leave/mine/balances?year=2026');
  const row = (r.data || []).find((b) => b.code === 'CL');
  return row ? Number(row.available_days) : null;
};
// Guarantee headroom regardless of what the tenant's data looks like, so this
// test never depends on ambient state and never drains the demo user's quota.
await tenantQuery(t, `
  UPDATE leave_balances SET used_days = 0, updated_at = now()
   WHERE user_id = $1 AND period_year = 2026
     AND leave_type_id IN (SELECT id FROM leave_types WHERE code IN ('CL','LWP'))`, [tc.id]);

const before = await balOf();
step(1, before !== null && before >= 4, `baseline CL balance has headroom = ${before}`);

// ---- half day ------------------------------------------------------------
const hd = await api(tc, '/staff-leave', { method: 'POST', body: JSON.stringify({
  leave_type_id: cl.id, from_date: '2026-10-05', to_date: '2026-10-05', half_day: 'first_half', reason: 'zz-lop half',
}) });
step(2, hd.status === 201 || hd.status === 200, `half-day applied (${hd.status})`);
step(3, Number(hd.data?.day_count) === 0.5, `half day counts as 0.5, got ${hd.data?.day_count}`);

const hdBad = await api(tc, '/staff-leave', { method: 'POST', body: JSON.stringify({
  leave_type_id: cl.id, from_date: '2026-11-02', to_date: '2026-11-04', half_day: 'first_half', reason: 'zz-lop badhalf',
}) });
step(4, hdBad.status >= 400, `half day across a 3-day range is rejected (${hdBad.status})`);

// ---- LOP on approval -----------------------------------------------------
const lv = await api(tc, '/staff-leave', { method: 'POST', body: JSON.stringify({
  leave_type_id: cl.id, from_date: '2026-10-12', to_date: '2026-10-14', reason: 'zz-lop three',
}) });
step(5, Number(lv.data?.day_count) === 3, `3-day leave applied, day_count=${lv.data?.day_count}`);

const over = await api(tl, `/staff-leave/${lv.data.id}/decide`, { method: 'POST', body: JSON.stringify({
  approve: true, mark_lop: true, lop_days: 5, lop_note: 'too many',
}) });
step(6, over.status === 400, `lop_days greater than the leave length is rejected (${over.status})`);

const odd = await api(tl, `/staff-leave/${lv.data.id}/decide`, { method: 'POST', body: JSON.stringify({
  approve: true, mark_lop: true, lop_days: 1.3,
}) });
step(7, odd.status === 400, `lop_days not in 0.5 steps is rejected (${odd.status})`);

const dec = await api(tl, `/staff-leave/${lv.data.id}/decide`, { method: 'POST', body: JSON.stringify({
  approve: true, mark_lop: true, lop_days: 1, lop_note: 'zz-lop 1 day unpaid',
}) });
step(8, dec.status === 200, `approved with 1 of 3 days marked LOP (${dec.status})`);

const { rows: [saved] } = await tenantQuery(t, `SELECT status, is_lop, lop_days, day_count FROM staff_leave WHERE id=$1`, [lv.data.id]);
step(9, saved.status === 'approved', `leave is approved (status=${saved.status})`);
step(10, saved.is_lop === true && Number(saved.lop_days) === 1, `persisted is_lop=${saved.is_lop} lop_days=${saved.lop_days}`);

// The double-charge guard: 3 days taken, 1 unpaid -> only 2 come off quota.
// Assert on the LEDGER row for this specific leave rather than a balance
// snapshot: the balance also moves for any other leave the demo user holds,
// which made this assertion flap between runs.
const { rows: [led] } = await tenantQuery(t,
  `SELECT delta_days FROM leave_ledger WHERE leave_id = $1 AND reason = 'approved'`, [lv.data.id]);
step(11, led && Math.abs(Number(led.delta_days) - 2) < 0.001,
  `only the 2 PAID days were charged to quota (ledger delta ${led?.delta_days}, of 3 days with 1 LOP)`);

// available_days deliberately also HOLDS pending requests so the same days
// cannot be booked twice, so the drop is the 2 charged days PLUS the 0.5
// half-day still awaiting a decision. Assert that composition explicitly.
const after = await balOf();
const expectedDrop = Number(led?.delta_days ?? 0) + 0.5;
step(11.5, before !== null && after !== null && Math.abs((before - after) - expectedDrop) < 0.001,
  `balance drop = 2 charged + 0.5 held pending (${before} -> ${after}, expected ${expectedDrop})`);

if (process.env.DEBUG_LEDGER) {
  const dbg = await tenantQuery(t, `
    SELECT l.reason, l.day_count, l.lop_days, l.status, g.delta_days, g.reason AS ledger_reason
      FROM staff_leave l LEFT JOIN leave_ledger g ON g.leave_id = l.id
     WHERE l.reason LIKE 'zz-lop%' ORDER BY l.from_date`);
  console.table(dbg.rows);
}

// ---- payroll's monthly view ---------------------------------------------
const { rows: [agg] } = await tenantQuery(t, `
  SELECT COALESCE(SUM(lop_days),0) AS lop
    FROM staff_leave
   WHERE user_id=$1 AND status='approved' AND lop_days > 0
     AND from_date <= date '2026-10-31' AND to_date >= date '2026-10-01'`, [tc.id]);
step(12, Number(agg.lop) === 1, `payroll reads 1 unpaid day for Oct 2026, got ${agg.lop}`);

// ---- default follows the leave type when the approver says nothing -------
const lwpType = await tenantQuery(t, `SELECT id FROM leave_types WHERE code='LWP' AND deleted_at IS NULL LIMIT 1`);
if (lwpType.rows[0]) {
  const lw = await api(tc, '/staff-leave', { method: 'POST', body: JSON.stringify({
    leave_type_id: lwpType.rows[0].id, from_date: '2026-10-20', to_date: '2026-10-21', reason: 'zz-lop lwp',
  }) });
  await api(tl, `/staff-leave/${lw.data.id}/decide`, { method: 'POST', body: JSON.stringify({ approve: true }) });
  const { rows: [lwSaved] } = await tenantQuery(t, `SELECT is_lop, lop_days FROM staff_leave WHERE id=$1`, [lw.data.id]);
  step(13, lwSaved.is_lop === true && Number(lwSaved.lop_days) === 2,
    `LWP defaults to fully unpaid with no approver input (is_lop=${lwSaved.is_lop}, ${lwSaved.lop_days}d)`);
}

await clean();
console.log(fail ? `\n${fail} FAILED` : '\nall green');
await closeAllTenantPools(); await closeSystemPool();
process.exit(fail ? 1 : 0);
