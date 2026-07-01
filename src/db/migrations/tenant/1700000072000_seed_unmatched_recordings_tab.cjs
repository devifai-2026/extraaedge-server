/* eslint-disable camelcase */
// Grant the `unmatched_recordings` tab to existing role rows.
//
// Counsellors review their OWN unmatched call recordings (uploaded from the
// mobile app); managers/admins see them in scope. Roles snapshot
// DEFAULT_TAB_KEYS at provisioning, so adding the key to constants.js alone
// won't retro-grant it — this backfills the tab_permissions JSON.
//
// Idempotent: only adds the key when absent.
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || jsonb_build_object('unmatched_recordings', 'full'),
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('super_admin', 'branch_manager', 'sales_manager', 'counsellor')
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'unmatched_recordings');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions - 'unmatched_recordings',
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('super_admin', 'branch_manager', 'sales_manager', 'counsellor');
  `);
};
