/* eslint-disable camelcase */
// Backfill the system `branch_manager` role into already-provisioned tenants.
//
// The org is now branch-wise: each branch has one branch_manager, and the
// sales_manager / counsellor / account_manager roles report up to them.
// branch_manager has admin-like access EXCEPT the full lead CSV export and
// sudo-login (impersonation) — both enforced at the route layer, not via tab
// keys — so its tab grant is the full set, identical to super_admin.
//
// Fresh tenants get this role from tenant-provisioning.js. This migration
// covers tenants that were provisioned before the role existed.
//
// We copy the tab_permissions from THIS tenant's existing super_admin role so
// the grant always matches the tenant's current full tab set (no drift if
// DEFAULT_TAB_KEYS changes between deploys). Idempotent via the UNIQUE(name)
// constraint on custom_roles + ON CONFLICT DO NOTHING.
exports.up = (pgm) => {
  pgm.sql(`
    INSERT INTO custom_roles (name, description, scope, is_system, tab_permissions)
    SELECT
      'branch_manager',
      'Runs a branch — admin-like, minus lead export & user impersonation',
      'branch_manager',
      true,
      COALESCE(
        (SELECT tab_permissions
           FROM custom_roles
          WHERE scope = 'super_admin' AND deleted_at IS NULL
          ORDER BY created_at
          LIMIT 1),
        '{}'::jsonb
      )
    ON CONFLICT (name) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  // Only remove the role if no users are assigned to it, so a down-migration
  // can't orphan live accounts. is_system rows are otherwise undeletable via
  // the API; this is a schema-level cleanup for the seeded row.
  pgm.sql(`
    DELETE FROM custom_roles cr
     WHERE cr.scope = 'branch_manager'
       AND cr.is_system = true
       AND NOT EXISTS (
         SELECT 1 FROM users u
          WHERE u.role_id = cr.id AND u.deleted_at IS NULL
       );
  `);
};
