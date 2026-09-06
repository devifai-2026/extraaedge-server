/* eslint-disable camelcase */
// Job-level assignee pool for a bulk lead upload.
//
// Until now the only way to set an owner during an import was a per-row
// `assigned_to_email` column in the spreadsheet; rows without it fell to the
// tenant-wide round-robin at the end of the job. The upload dialog now has an
// "Assign to" picker so an operator can name one person — or several, who then
// share the file evenly — without editing the spreadsheet.
//
// Bare uuid[] with no FK, matching assignment_rules.target_users and
// lead_routing_pools.member_ids: a member who is later deactivated or moved to
// a role that can't own leads must never require rewriting a historical import
// row. The worker re-checks eligibility against LEAD_OWNER_ROLES at run time.
//
// Empty array (the default) = unchanged behaviour: per-row email, then the
// assignment rules.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE bulk_imports
      ADD COLUMN IF NOT EXISTS assignee_pool uuid[] NOT NULL DEFAULT '{}';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE bulk_imports DROP COLUMN IF EXISTS assignee_pool;
  `);
};
