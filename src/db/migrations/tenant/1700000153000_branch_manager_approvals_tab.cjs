/* eslint-disable camelcase */

// Un-hide 'accounts.approvals' for the branch_manager role.
//
// WHY: branch_manager used to hold the '*' tab wildcard, so the only way to
// keep it out of the Accounts module was to mark every accounts.* key
// 'hidden' in its stored tab_permissions. That was the right call at the time.
//
// The role now has an explicit grant list (BRANCH_MANAGER_TAB_KEYS) instead of
// the wildcard, and buildAllowedTabs treats a stored row as subtract-only: the
// list is the grant, an explicit 'hidden' removes from it. So that historical
// row keeps stripping the ONE accounts key the role is now meant to have.
//
// accounts.approvals matters because it is the only route to the admission
// detail page (/accounts/admission/:id), which is where a student's
// REGISTRATION receipt can be viewed, downloaded and share-linked. Collecting
// the registration amount is the one money approval a branch manager owns, so
// without this they have a balance to chase and no way to reach the receipt
// proving it was paid.
//
// Deliberately narrow: only this one key, only on the branch_manager role, and
// only where it is currently 'hidden'. Every other accounts.* key stays hidden
// — those are the real money surfaces (dashboard, pay schedule, collection
// receipt-wise, payment details) and the role is not granted them anyway.

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions || '{"accounts.approvals":"full"}'::jsonb
     WHERE name = 'branch_manager'
       AND tab_permissions -> 'accounts.approvals' = '"hidden"';
  `);
};

// Reversible: put the key back to 'hidden' on the same role.
exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions || '{"accounts.approvals":"hidden"}'::jsonb
     WHERE name = 'branch_manager'
       AND tab_permissions ? 'accounts.approvals';
  `);
};
