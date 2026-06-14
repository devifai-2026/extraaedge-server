/* eslint-disable camelcase */
// Backfill the `lead_transfer_report` tab into existing role rows.
//
// The Lead Report (Lead Transfer Report) is for admins + sales managers.
// Roles snapshot DEFAULT_TAB_KEYS at provisioning, so adding the key to
// constants.js doesn't retro-grant it to already-provisioned tenants —
// their sales_manager role's tab_permissions JSON has no entry, and
// buildAllowedTabs() only emits keys that ARE present, so the sidebar item
// stays hidden for managers. This grants it.
//
// Idempotent: jsonb merge only adds the key; we don't touch a per-tenant
// custom level if one already exists.
exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || jsonb_build_object('lead_transfer_report', 'full'),
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('super_admin', 'sales_manager')
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'lead_transfer_report');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions - 'lead_transfer_report',
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('super_admin', 'sales_manager');
  `);
};
