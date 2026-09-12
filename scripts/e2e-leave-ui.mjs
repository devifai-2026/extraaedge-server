// E2E: the leave surfaces every role must be able to REACH.
//
// The backend was complete before this and still unusable, because no role held
// the tab keys and no page existed. This asserts both halves: the tab grant and
// the endpoint behind it.
import 'dotenv/config';
import { resolveTenantBySlug, tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { closeSystemPool } from '../src/db/system.js';
import { signAccessToken } from '../src/lib/jwt.js';

const BASE = 'http://localhost:4001/api/v1';
const t = await resolveTenantBySlug('demo');
let fail = 0;
const step = (ok, msg) => { if (!ok) fail += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const as = (x) => signAccessToken({ sub: x.id, tenantId: t.id, tenantSlug: 'demo', role: x.role, sessionId: 'lv-ui', type: 'access' });
const api = async (x, path) => {
  const r = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${as(x)}` } });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, data: j?.data };
};

// One live user per staff role.
const { rows: users } = await tenantQuery(t, `
  SELECT DISTINCT ON (role) id, role, name, email
    FROM users WHERE deleted_at IS NULL AND is_active AND role <> 'student'
   ORDER BY role, created_at`);

console.log(`\n1. Every staff role can reach its own leave (${users.length} roles)`);
for (const u of users) {
  const mine = await api(u, '/staff-leave/mine');
  const bal = await api(u, '/staff-leave/mine/balances');
  const cal = await api(u, '/staff-leave/calendar?from=2026-09-01&to=2026-09-30');
  const ok = mine.status === 200 && bal.status === 200 && cal.status === 200;
  step(ok, `${u.role.padEnd(18)} mine=${mine.status} balances=${bal.status} calendar=${cal.status}`);
}

console.log('\n2. Tab grants match the pages that exist');
const { rows: roles } = await tenantQuery(t, `
  SELECT scope,
         (tab_permissions ? 'hr.my_leave')        AS my_leave,
         (tab_permissions ? 'hr.leave_calendar')  AS cal,
         (tab_permissions ? 'hr.leave_approvals') AS appr,
         (tab_permissions ? 'hr.leave_admin')     AS adm
    FROM custom_roles WHERE deleted_at IS NULL ORDER BY scope`);
const staff = roles.filter((r) => r.scope !== 'student');
step(staff.every((r) => r.my_leave), `all ${staff.length} staff roles hold hr.my_leave`);
step(staff.every((r) => r.cal), `all staff roles hold hr.leave_calendar`);
const student = roles.find((r) => r.scope === 'student');
step(student && !student.my_leave && !student.cal, `student holds NEITHER (not an employee)`);

const approvers = roles.filter((r) => r.appr).map((r) => r.scope).sort();
step(!approvers.includes('counsellor') && !approvers.includes('telecaller'),
  `front line has no approvals inbox (approvers: ${approvers.join(', ')})`);
const admins = roles.filter((r) => r.adm).map((r) => r.scope).sort();
step(JSON.stringify(admins) === JSON.stringify(['branch_manager', 'hr_team_lead', 'super_admin']),
  `leave admin limited to HR + admin tiers (${admins.join(', ')})`);

console.log('\n3. Authority is enforced server-side, not just hidden in the nav');
const { rows: [tc] } = await tenantQuery(t, `SELECT id, role FROM users WHERE email='telecaller@demo.local'`);
const { rows: [hr] } = await tenantQuery(t, `SELECT id, role FROM users WHERE email='hr@demo.local'`);
const q1 = await api(tc, '/staff-leave/queue/pending');
step(q1.status === 403, `telecaller is refused the approver queue (${q1.status})`);
const p1 = await api(tc, '/staff-leave/policies');
step(p1.status === 403, `telecaller is refused the policy admin (${p1.status})`);
// Policy administration is the HR LEAD's, not every HR user's — it must match
// the server's LEAVE_ADMIN set, or the nav shows a link that 403s.
const { rows: [htl] } = await tenantQuery(t, `SELECT id, role FROM users WHERE role='hr_team_lead' AND deleted_at IS NULL LIMIT 1`);
if (htl) {
  const p2 = await api(htl, '/staff-leave/policies');
  step(p2.status === 200 && Array.isArray(p2.data),
    `hr_team_lead REACHES the policy admin — '/policies' no longer shadowed by '/:id' (${p2.status})`);
}
const p3 = await api(hr, '/staff-leave/policies');
step(p3.status === 403, `flat hr is refused policy admin, matching LEAVE_ADMIN (${p3.status})`);
const reg = await api(tc, '/staff-leave?from=2026-09-01&to=2026-09-30');
step(reg.status === 403, `front line is refused the full register, which carries reasons (${reg.status})`);
const q2 = await api(hr, '/staff-leave/queue/pending');
step(q2.status === 200, `HR reaches the approver queue (${q2.status})`);

console.log('\n4. Calendar returns only what a calendar needs');
const cal = await api(hr, '/staff-leave/calendar?from=2026-09-01&to=2026-09-30');
step(cal.status === 200 && Array.isArray(cal.data), `org calendar returns a list (${cal.status})`);
// The calendar must not leak WHY somebody is away.
const leaked = (cal.data || []).filter((r) => 'reason' in r || 'decision_note' in r || 'lop_days' in r);
step(leaked.length === 0, `calendar carries no reason / note / LOP field (${leaked.length} leaks)`);

console.log(fail ? `\n${fail} FAILED` : '\nall green');
await closeAllTenantPools(); await closeSystemPool();
process.exit(fail ? 1 : 0);
