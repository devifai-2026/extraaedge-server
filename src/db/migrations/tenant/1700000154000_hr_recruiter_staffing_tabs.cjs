/* eslint-disable camelcase */

// Grant hr_recruiter the staffing tabs: leave administration and payroll.
//
// WHY A MIGRATION AND NOT JUST THE CONSTANT: HR_RECRUITER_TAB_KEYS in
// config/constants.js is only the SEED used when a role row is first created.
// For an existing role, buildAllowedTabs reads the stored custom_roles
// .tab_permissions row as the allowlist — it is subtract-only for
// branch_manager alone. Every other role, including this one, gets exactly
// what its stored row says.
//
// So editing the constant changed nothing for the tenant that already has the
// role seeded: the recruiter's row predates the grant and simply has no
// payroll.* or hr.leave_* keys, so those tabs stayed invisible however the
// code read. This backfills the row to match.
//
// Scope of the grant (product owner's call — "Recruitment & staffing"):
//   hr.leave_approvals  approve/decline staff leave
//   hr.leave_admin      quotas, policies, the holiday calendar
//   payroll.runs        compute a payroll run (NOT release it — DISBURSE_ROLES
//                       stays super_admin, so preparing and paying are still
//                       different people)
//   payroll.structures  salary structures. This does expose every employee's
//                       salary, which is inherent to the role owning payroll.
//
// Only adds keys that are ABSENT. A key explicitly set to 'hidden' is left
// alone — that is a deliberate choice by whoever set it, and this migration
// should not silently override it.

const TABS = [
  'hr.leave_approvals',
  'hr.leave_admin',
  'payroll.runs',
  'payroll.structures',
];

exports.up = (pgm) => {
  for (const tab of TABS) {
    pgm.sql(`
      UPDATE custom_roles
         SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                               || '{"${tab}":"full"}'::jsonb
       WHERE name = 'hr_recruiter'
         AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? '${tab}');
    `);
  }
};

// Remove only the keys this migration could have added, and only where they
// still read 'full' — if someone has since set one to 'hidden', that is their
// decision and reverting should not disturb it.
exports.down = (pgm) => {
  for (const tab of TABS) {
    pgm.sql(`
      UPDATE custom_roles
         SET tab_permissions = tab_permissions - '${tab}'
       WHERE name = 'hr_recruiter'
         AND tab_permissions -> '${tab}' = '"full"';
    `);
  }
};
