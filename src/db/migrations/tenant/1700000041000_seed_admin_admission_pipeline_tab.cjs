/* eslint-disable camelcase */
// Backfill `admissions.pipeline` tab into the super_admin role's
// tab_permissions JSON for existing tenants.
//
// Why: when the role was first seeded (tenant-provisioning.js), it
// snapshotted DEFAULT_TAB_KEYS into the row. Adding a new tab key to
// constants.js doesn't retro-update existing rows, so super_admins of
// already-provisioned tenants would lose access to the new sidebar
// item until someone manually edited the JSON.
//
// We also bake in the new tab for ANY role marked is_system=true that
// has its scope='super_admin' — covers the seed row and any future
// duplicates from custom-role copies.
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || jsonb_build_object('admissions.pipeline', 'full'),
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope = 'super_admin';
  `);
};

exports.down = (pgm) => {
  // Remove the key on rollback. We don't try to restore the previous
  // permission level — 'full' is the only value seeded at provisioning.
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions - 'admissions.pipeline',
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope = 'super_admin';
  `);
};
