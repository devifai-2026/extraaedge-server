/* eslint-disable camelcase */

// Grant the Duplicates tab to super_admin and branch_manager.
//
// Editing the tab constants only seeds NEW role rows — buildAllowedTabs reads
// the stored custom_roles.tab_permissions for a role that already exists, so
// an existing tenant needs this backfill or the page stays invisible however
// the code reads.
//
// super_admin holds the '*' wildcard and does not need the key, but is
// included so the row is explicit rather than relying on the wildcard.

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb) || '{"duplicates":"full"}'::jsonb
     WHERE name IN ('super_admin', 'branch_manager')
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'duplicates');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles SET tab_permissions = tab_permissions - 'duplicates'
     WHERE tab_permissions -> 'duplicates' = '"full"';
  `);
};
