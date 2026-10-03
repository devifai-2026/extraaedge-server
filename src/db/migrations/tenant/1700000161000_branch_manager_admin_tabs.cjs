/* eslint-disable camelcase */

// Grant 'admissions.pipeline' and 'courses.manage' to the branch_manager role.
//
// WHY A MIGRATION IS NEEDED AT ALL: buildAllowedTabs (modules/auth/service.js)
// treats BRANCH_MANAGER_TAB_KEYS as the grant and the stored tab_permissions
// row as SUBTRACT-ONLY — an explicit 'hidden' removes a key from the list.
// branch_manager held the '*' wildcard historically, so the only way to keep
// it out of surfaces back then was to mark them 'hidden' on its stored row.
// Adding the two keys to the code list is therefore not enough on its own:
// wherever the old row still says 'hidden', it keeps stripping them straight
// back out. This clears exactly those two, exactly on that role.
//
//   admissions.pipeline — the read-back on what the branch converted. Money is
//     withheld per FIELD, not by hiding the page: the list runs through
//     stripMoney and the detail page through stripAdmissionMoney, which passes
//     only the four registration_* figures and empties fee_schedule,
//     non-registration receipts and the fee offer's course_fees. Creating or
//     editing an admission remains the accounts team's (acctRole), and
//     branchManagerReadOnly blocks those writes regardless.
//
//   courses.manage — batch scheduling. Paired with the POST/PUT /classes
//     entries in branchManagerReadOnly; DELETE is deliberately not granted.
//
// Idempotent: the WHERE only matches rows where the key is currently 'hidden',
// so re-running changes nothing, and a tenant whose row never had the key is
// left alone (absent means "never configured", which the grant list covers).

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions
             || '{"admissions.pipeline":"full","courses.manage":"full"}'::jsonb
     WHERE name = 'branch_manager'
       AND (tab_permissions -> 'admissions.pipeline' = '"hidden"'
            OR tab_permissions -> 'courses.manage' = '"hidden"');
  `);
};

// Reversible: put both keys back to 'hidden' on the same role, but only where
// a key is actually present — so this never INVENTS a row for a tenant that
// never had one.
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions
             || '{"admissions.pipeline":"hidden","courses.manage":"hidden"}'::jsonb
     WHERE name = 'branch_manager'
       AND (tab_permissions ? 'admissions.pipeline'
            OR tab_permissions ? 'courses.manage');
  `);
};
