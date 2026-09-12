// Dummy-but-realistic salary structures for the demo tenant.
//
// Idempotent: re-running replaces each person's structure for the same
// effective date rather than stacking versions. Numbers follow the brief —
// extra class 500, demo class 300, admission incentive on a slab, telecaller
// call target — and every one of them is editable from the Payroll UI.
import 'dotenv/config';
import { resolveTenantBySlug, tenantQuery, closeAllTenantPools } from '../src/db/tenant.js';
import { closeSystemPool } from '../src/db/system.js';
import * as repo from '../src/modules/payroll/repo.js';

const slug = process.argv[2] || 'demo';
const EFFECTIVE_FROM = '2026-01-01';

const t = await resolveTenantBySlug(slug);
const comps = await repo.listComponents(t);
const byCode = Object.fromEntries(comps.map((c) => [c.code, c]));

// Monthly basic per role. Deliberately round numbers so a payslip is easy to
// eyeball during testing.
const BASIC = {
  super_admin: 120000, branch_manager: 90000, sales_manager: 55000,
  telecaller_lead: 45000, counsellor: 30000, telecaller: 25000,
  head_trainer: 60000, trainer: 40000, hr_team_lead: 55000, hr: 35000,
  hr_recruiter: 30000, placement: 35000, placement_officer: 32000,
  account_manager: 38000, qa: 32000,
};

// Variable heads by role — the flexible part of the brief.
const VARIABLE = {
  trainer: [['EXTRA_CLASS', 500], ['DEMO_CLASS', 300]],
  head_trainer: [['EXTRA_CLASS', 600], ['DEMO_CLASS', 300]],
  counsellor: [['ADM_INCENTIVE', 1000], ['DEMO_CLASS', 300]],
  telecaller: [['ADM_INCENTIVE', 750], ['CALL_INCENTIVE', 2000]],
  telecaller_lead: [['ADM_INCENTIVE', 1000], ['CALL_INCENTIVE', 3000]],
  sales_manager: [['ADM_INCENTIVE', 500]],
};

const { rows: staff } = await tenantQuery(
  t,
  `SELECT id, name, role FROM users
    WHERE deleted_at IS NULL AND is_active AND role <> 'student'
    ORDER BY role, name`,
);

let made = 0;
for (const u of staff) {
  const basic = BASIC[u.role];
  if (!basic) { console.log(`  skip ${u.role} (no band defined)`); continue; }

  const components = [
    { component_id: byCode.BASIC.id, amount: basic },
    { component_id: byCode.HRA.id, percent: 40 },
    { component_id: byCode.CONVEYANCE.id, amount: 1600 },
    { component_id: byCode.PF_EMP.id, percent: 12 },
    { component_id: byCode.PT.id, amount: 200 },
  ];
  for (const [code, rate] of VARIABLE[u.role] || []) {
    if (!byCode[code]) continue;
    components.push({ component_id: byCode[code].id, rate, default_units: 0 });
  }

  // monthly_gross is the fixed part only; variable pay is by definition not
  // guaranteed, so folding it into CTC would overstate the offer.
  const monthlyGross = basic + basic * 0.4 + 1600;
  // eslint-disable-next-line no-await-in-loop
  await repo.saveStructure(t, {
    userId: u.id,
    effectiveFrom: EFFECTIVE_FROM,
    annualCtc: Math.round(monthlyGross * 12),
    monthlyGross: Math.round(monthlyGross),
    notes: 'Seeded demo structure — editable from Payroll › Salary Structures',
    components,
    actorId: null,
  });
  made += 1;
}
console.log(`\nstructures: ${made} of ${staff.length} staff`);

// ---- incentive slabs ------------------------------------------------------
// Role-wide bands. A per-user slab (user_id set) would override these.
const SLABS = [
  ['ADM_INCENTIVE', 'counsellor', 0, 4, 750, 0],
  ['ADM_INCENTIVE', 'counsellor', 5, 9, 1000, 0],
  ['ADM_INCENTIVE', 'counsellor', 10, null, 1500, 5000],   // 10+ adds a 5k bonus
  ['ADM_INCENTIVE', 'telecaller', 0, 4, 500, 0],
  ['ADM_INCENTIVE', 'telecaller', 5, null, 750, 0],
  ['CALL_INCENTIVE', 'telecaller', 1, null, 2000, 0],
  ['CALL_INCENTIVE', 'telecaller_lead', 1, null, 3000, 0],
];

await tenantQuery(t, `DELETE FROM incentive_slabs WHERE user_id IS NULL`);
for (const [code, role, min, max, per, flat] of SLABS) {
  if (!byCode[code]) continue;
  // eslint-disable-next-line no-await-in-loop
  await repo.upsertSlab(t, {
    component_id: byCode[code].id, user_id: null, role_scope: role,
    min_units: min, max_units: max, amount_per_unit: per, flat_amount: flat, is_active: true,
  });
}
console.log(`slabs: ${SLABS.length}`);

await closeAllTenantPools();
await closeSystemPool();
process.exit(0);
