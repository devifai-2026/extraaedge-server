/* eslint-disable camelcase */

// Give the Duplicate Leads page to counsellors and telecallers.
//
// They see a NARROWER page than a manager does: the scan only returns groups
// where they own EVERY lead, and the merge endpoint re-checks the same rule
// rather than trusting that filter. So a front-line user can tidy their own
// list but can never merge a colleague's lead into theirs — which would be a
// silent reassignment the other owner never sees.
//
// telecaller_lead is included: it carries a personal queue like any other lead
// owner, and the same own-everything rule applies to it.
//
// Editing the tab constants only seeds NEW role rows, so an existing tenant
// needs this backfill or the page stays invisible however the code reads.

const ROLES = ['counsellor', 'telecaller', 'telecaller_lead'];

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb) || '{"duplicates":"full"}'::jsonb
     WHERE name IN (${ROLES.map((r) => `'${r}'`).join(', ')})
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'duplicates');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles SET tab_permissions = tab_permissions - 'duplicates'
     WHERE name IN (${ROLES.map((r) => `'${r}'`).join(', ')})
       AND tab_permissions -> 'duplicates' = '"full"';
  `);
};
