/* eslint-disable camelcase */
// Split the front line into three roles. Until now every lead-working staff
// member was a `counsellor`; the org now distinguishes:
//
//   sales_manager
//     ├── counsellor          (unchanged)
//     ├── telecaller_lead     NEW — runs a team of telecallers
//     └── ...
//   telecaller_lead
//     └── telecaller          NEW — works a personal queue of assigned leads
//
// This migration ONLY inserts the two custom_roles rows. It deliberately does
// NOT touch a single `users` row: every existing counsellor stays a
// counsellor, and an admin moves individuals across with the Switch Role
// action (POST /users/:id/switch-role). Nothing is deleted anywhere.
//
// Tab grants are COPIED from this tenant's own existing counsellor /
// sales_manager rows rather than hard-coded, so the grant always matches the
// tenant's current tab set and can't drift when DEFAULT_TAB_KEYS changes
// between deploys. Same approach as 1700000063000_seed_branch_manager_role.
// Fresh tenants get these roles from tenant-provisioning.js instead.
//
// Idempotent via the UNIQUE(name) constraint on custom_roles.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  const roles = [
    {
      name: 'telecaller_lead',
      description: 'Runs a team of telecallers',
      // Mirrors sales_manager: everything except tenant administration.
      copy_from: 'sales_manager',
    },
    {
      name: 'telecaller',
      description: 'Handles assigned leads (telecalling)',
      // Mirrors counsellor: a personal queue of assigned leads.
      copy_from: 'counsellor',
    },
  ];

  for (const r of roles) {
    // eslint-disable-next-line no-await-in-loop
    await pgm.db.query(
      `INSERT INTO custom_roles (name, description, scope, is_system, tab_permissions)
       SELECT $1, $2, $1, true,
              COALESCE(
                (SELECT tab_permissions
                   FROM custom_roles
                  WHERE scope = $3 AND deleted_at IS NULL
                  ORDER BY created_at
                  LIMIT 1),
                '{}'::jsonb
              )
       ON CONFLICT (name) DO NOTHING`,
      [r.name, r.description, r.copy_from],
    );
  }
};

exports.down = async (pgm) => {
  // Only drop the seeded rows when nobody holds them, so a down-migration can
  // never orphan a live account. is_system rows are undeletable via the API;
  // this is a schema-level cleanup only.
  await pgm.db.query(
    `DELETE FROM custom_roles c
      WHERE c.scope IN ('telecaller_lead', 'telecaller')
        AND c.is_system = true
        AND NOT EXISTS (
          SELECT 1 FROM users u WHERE u.role_id = c.id AND u.deleted_at IS NULL
        )`,
  );
};
