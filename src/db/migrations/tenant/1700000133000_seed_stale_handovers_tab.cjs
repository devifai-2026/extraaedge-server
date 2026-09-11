/* eslint-disable camelcase */
// Grant the `stale_handovers` tab (Stale Leads) to the admin + manager tiers.
//
// The 6-day / 7-day stale-lead rule already runs headless in
// workers/sla-scanner.js: day 6 notifies the owner and their chain, day 7
// auto-reassigns the lead to someone else in the SAME role class. Nothing in
// the UI showed what it had done, so "what moved to whom?" could only be
// answered by reading sla_alerts by hand. This tab is that view.
//
// Granted to super_admin + branch_manager + sales_manager + telecaller_lead:
// unlike reassign_logs (which audits the managers themselves and stays with
// the tenant owner), these are the people who get notified on day 6 and who
// need to act before day 7 — the report is useless to them if they can't see
// it. Each still only sees their own scope; the endpoint is behind
// MANAGER_TIER_ROLES.
//
// Roles snapshot DEFAULT_TAB_KEYS at provisioning time, so adding the key to
// constants.js does NOT retro-grant it to existing tenants — buildAllowedTabs()
// only emits keys present in tab_permissions. Idempotent: the jsonb merge adds
// the key only when absent, so a later per-tenant custom level is never lost.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || jsonb_build_object('stale_handovers', 'full'),
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('super_admin', 'branch_manager', 'sales_manager', 'telecaller_lead')
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'stale_handovers');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions - 'stale_handovers',
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('super_admin', 'branch_manager', 'sales_manager', 'telecaller_lead');
  `);
};
