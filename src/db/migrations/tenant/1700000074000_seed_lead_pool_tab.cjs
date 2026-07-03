/* eslint-disable camelcase */
// Grant the `lead_pool` tab to existing role rows.
//
// The Lead Pool is a tenant-wide, READ-ONLY lookup: any counsellor (and up)
// can search ANY lead in the tenant by name or phone and see its details plus
// current owner, manager and previous owner. Roles snapshot DEFAULT_TAB_KEYS
// at provisioning, so adding the key to constants.js alone won't retro-grant
// it to already-provisioned tenants — this backfills the tab_permissions JSON.
//
// Granted to the sales-team roles (super_admin / branch_manager / sales_manager
// / counsellor). Account managers work the separate Accounts module and don't
// get it here (a super_admin can still toggle it on per-role from the UI).
//
// Idempotent: only adds the key when absent.
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || jsonb_build_object('lead_pool', 'full'),
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('super_admin', 'branch_manager', 'sales_manager', 'counsellor')
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'lead_pool');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions - 'lead_pool',
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('super_admin', 'branch_manager', 'sales_manager', 'counsellor');
  `);
};
