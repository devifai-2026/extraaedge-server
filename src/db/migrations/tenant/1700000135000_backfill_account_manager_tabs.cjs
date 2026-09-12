/* eslint-disable camelcase */
// Restore the Accounts tabs that the provisioning seed used to wipe.
//
// provisionTenantDatabase ran applyMigrations and THEN seedTenantDefaults, and
// the seed's upsert did `tab_permissions = EXCLUDED.tab_permissions` — a
// replace, not a merge. So every accounts.* key the earlier migrations had
// granted to account_manager was overwritten on a freshly provisioned tenant,
// and because those migrations guard themselves against re-running, nothing
// ever put them back. The result: an Accounts team with full API access and no
// navigation to reach it.
//
// The seed itself is fixed (services/tenant-provisioning.js now merges). This
// migration repairs tenants that were provisioned while it was broken —
// learn-synaptic had 2 of the 13 keys, exactly the two whose migrations
// happened to run after it was created.
//
// Idempotent per key: the jsonb merge only adds a key that is absent, so a
// tenant that already has the full set is untouched, and a per-tenant custom
// level set by an admin is never clobbered.

exports.shorthands = undefined;

const KEYS = [
  'accounts.dashboard',
  'accounts.pending_admissions',
  'accounts.this_month_admissions',
  'accounts.total_admissions',
  'accounts.approvals',
  'accounts.attendings',
  'accounts.break',
  'accounts.drop_candidates',
  'accounts.report',
  'accounts.pay_schedule',
  'accounts.collection_receipt_wise',
  'accounts.payment_details',
  'accounts.bulk_import',
];

exports.up = (pgm) => {
  for (const key of KEYS) {
    pgm.sql(`
      UPDATE custom_roles
         SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                               || jsonb_build_object('${key}', 'full'),
             updated_at = now()
       WHERE deleted_at IS NULL
         AND scope = 'account_manager'
         AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? '${key}');
    `);
  }
};

exports.down = (pgm) => {
  // Only removes the keys this migration could have added. Deliberately does
  // not restore the broken state on a tenant that was already correct.
  for (const key of KEYS) {
    pgm.sql(`
      UPDATE custom_roles
         SET tab_permissions = tab_permissions - '${key}',
             updated_at = now()
       WHERE deleted_at IS NULL AND scope = 'account_manager';
    `);
  }
};
