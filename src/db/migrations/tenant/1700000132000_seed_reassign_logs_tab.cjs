/* eslint-disable camelcase */
// Grant the `reassign_logs` tab to super_admin ONLY.
//
// Reassign Logs is an actor-first audit of manual lead moves: who moved which
// leads onto whom, and how many at a time. It exists because a lead
// distribution rule can be configured correctly and still be bypassed — a
// manual reassign overwrites the routed owner, and the live lead row shows
// only the end state, so from the Lead Manager a bulk move is
// indistinguishable from a leaking rule.
//
// Deliberately NOT granted to sales_manager / branch_manager / telecaller_lead,
// unlike the neighbouring lead_transfer_report: the managers are exactly the
// people this log audits, so it stays with the tenant owner. (A super_admin can
// still hand it to a specific role from Users & Roles if they want to.)
//
// Roles snapshot DEFAULT_TAB_KEYS at provisioning time, so adding the key to
// constants.js does NOT retro-grant it to already-provisioned tenants —
// buildAllowedTabs() only emits keys present in tab_permissions. This migration
// backfills it. Fresh tenants get it from DEFAULT_TAB_KEYS via provisioning.
//
// Idempotent: the jsonb merge only adds the key when it is absent, so a
// per-tenant custom level set later is never clobbered by a re-run.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || jsonb_build_object('reassign_logs', 'full'),
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope = 'super_admin'
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'reassign_logs');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions - 'reassign_logs',
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope = 'super_admin';
  `);
};
