// E2E: the payroll surfaces each role can REACH.
//
// The leave module was complete server-side and still invisible because no role
// held the tab keys. This asserts both halves for payroll: the tab grant AND
// the endpoint behind it agree, so the nav can never render a link that 403s.
import 'dotenv/config';
import { resolveTenantBySlug, tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { closeSystemPool } from '../src/db/system.js';
import { signAccessToken } from '../src/lib/jwt.js';

const BASE = 'http://localhost:4001/api/v1';
const t = await resolveTenantBySlug('demo');
let fail = 0;
const step = (ok, msg) => { if (!ok) fail += 1; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${msg}`); };
const as = (x) => signAccessToken({ sub: x.id, tenantId: t.id, tenantSlug: 'demo', role: x.role, sessionId: 'pui', type: 'access' });
const api = async (x, p) => {
  const r = await fetch(`${BASE}${p}`, { headers: { authorization: `Bearer ${as(x)}` } });
  return { status: r.status, data: (await r.json().catch(() => ({})))?.data };
};

const { rows: users } = await tenantQuery(t, `
  SELECT DISTINCT ON (role) id, role FROM users
   WHERE deleted_at IS NULL AND is_active AND role <> 'student' ORDER BY role, created_at`);

console.log(`\n1. Every staff role reaches its OWN payslips (${users.length} roles)`);
for (const u of users) {
  const r = await api(u, '/payroll/my/payslips');
  step(r.status === 200, `${u.role.padEnd(18)} my/payslips -> ${r.status}`);
}

console.log('\n2. Salary administration is limited to PAYROLL_ADMIN_ROLES');
const admins = [];
for (const u of users) {
  const r = await api(u, '/payroll/runs');
  if (r.status === 200) admins.push(u.role);
  else if (r.status !== 403) step(false, `${u.role}: unexpected ${r.status} on /payroll/runs`);
}
step(JSON.stringify(admins.sort()) === JSON.stringify(['branch_manager', 'hr_team_lead', 'super_admin']),
  `only admin tiers + HR lead can run payroll (${admins.join(', ')})`);

console.log('\n3. Tab grants agree with the API — no link that 403s');
const { rows: roles } = await tenantQuery(t, `
  SELECT scope,
         (tab_permissions ? 'payroll.my_payslips') AS mine,
         (tab_permissions ? 'payroll.runs')        AS runs,
         (tab_permissions ? 'payroll.structures')  AS structs
    FROM custom_roles WHERE deleted_at IS NULL ORDER BY scope`);
const staff = roles.filter((r) => r.scope !== 'student');
step(staff.every((r) => r.mine), `all ${staff.length} staff roles hold payroll.my_payslips`);
const student = roles.find((r) => r.scope === 'student');
step(student && !student.mine, `student holds none of them (not an employee)`);

const tabRuns = roles.filter((r) => r.runs).map((r) => r.scope).sort();
step(JSON.stringify(tabRuns) === JSON.stringify(['branch_manager', 'hr_team_lead', 'super_admin']),
  `payroll.runs tab matches exactly who the API admits (${tabRuns.join(', ')})`);

console.log('\n4. A line manager cannot read a report\'s salary');
const { rows: [sm] } = await tenantQuery(t, `SELECT id, role FROM users WHERE role='sales_manager' AND deleted_at IS NULL LIMIT 1`);
const { rows: [tc] } = await tenantQuery(t, `SELECT id FROM users WHERE email='telecaller@demo.local'`);
const peek = await api(sm, `/payroll/structures/${tc.id}`);
step(peek.status === 403, `sales_manager refused a report's structure (${peek.status})`);
const smRuns = await api(sm, '/payroll/runs');
step(smRuns.status === 403, `and refused the runs list (${smRuns.status})`);

console.log('\n5. Structures exist, so a run can actually compute');
const { rows: [cnt] } = await tenantQuery(t, `
  SELECT count(*)::int n FROM employee_salary_structures WHERE deleted_at IS NULL AND effective_to IS NULL`);
step(cnt.n > 0, `${cnt.n} employees have a current salary structure`);
const { rows: [sl] } = await tenantQuery(t, `SELECT count(*)::int n FROM incentive_slabs WHERE deleted_at IS NULL`);
step(sl.n > 0, `${sl.n} incentive slabs configured`);

console.log(fail ? `\n${fail} FAILED` : '\nall green');
await closeAllTenantPools(); await closeSystemPool();
process.exit(fail ? 1 : 0);
