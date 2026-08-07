/* eslint-disable camelcase */
// Grant sales_manager full workflow parity with super_admin/branch_manager
// on the Admissions/Accounts module: the tenant-wide "Admission Pipeline"
// page + every accounts.* tab (Pending/This Month/Total Admissions,
// Approvals, Attendings, Break, Drop Candidates, Report, Pay Schedule,
// Collection Receipt-wise, Payment Details, Import Past Admissions).
//
// Backend route access (admissions/routes.js acctRole/acctOrBranch) and
// row-level scoping (admissions/service.js resolveAdmissionScope +
// assertAdmissionInScope, scoped to the sales_manager's team subtree) were
// updated in the same change — this migration is the tab_permissions half.
//
// branch_manager needs no entry here: buildAllowedTabs() already returns the
// '*' wildcard for that role regardless of its stored tab_permissions.
//
// Also backfills the newly-introduced 'accounts.payment_details' key to
// super_admin and account_manager — that key existed on the Sidebar item +
// route guard but was never added to DEFAULT_TAB_KEYS, so only wildcard-tab
// roles (super_admin, branch_manager) could ever actually reach the page.
//
// Idempotent: jsonb merge only adds missing keys, never overwrites an
// existing per-tenant customisation of a key that's already set.
exports.shorthands = undefined;

const SALES_MANAGER_TABS = {
  'admissions.pipeline': 'full',
  'accounts.dashboard': 'full',
  'accounts.pending_admissions': 'full',
  'accounts.this_month_admissions': 'full',
  'accounts.total_admissions': 'full',
  'accounts.approvals': 'full',
  'accounts.attendings': 'full',
  'accounts.break': 'full',
  'accounts.drop_candidates': 'full',
  'accounts.report': 'full',
  'accounts.pay_schedule': 'full',
  'accounts.collection_receipt_wise': 'full',
  'accounts.payment_details': 'full',
  'accounts.bulk_import': 'full',
};

exports.up = async (pgm) => {
  // One UPDATE per key, each guarded by "not already set" — so a tenant that
  // manually hid one of these for their sales_manager role (Advanced Settings
  // > Roles) before a migration replay keeps that choice instead of it being
  // silently reset back to 'full'.
  for (const [key, level] of Object.entries(SALES_MANAGER_TABS)) {
    await pgm.db.query(
      `UPDATE custom_roles
          SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb) || jsonb_build_object($1::text, $2::text),
              updated_at = now()
        WHERE deleted_at IS NULL
          AND scope = 'sales_manager'
          AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? $1::text)`,
      [key, level],
    );
  }
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                              || '{"accounts.payment_details": "full"}'::jsonb,
            updated_at = now()
      WHERE deleted_at IS NULL
        AND scope IN ('super_admin', 'account_manager')
        AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'accounts.payment_details')`,
  );
};

exports.down = async (pgm) => {
  const keys = Object.keys(SALES_MANAGER_TABS).map((k) => `'${k}'`).join(', ');
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions - ARRAY[${keys}]::text[],
            updated_at = now()
      WHERE deleted_at IS NULL
        AND scope = 'sales_manager'`,
  );
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions - 'accounts.payment_details',
            updated_at = now()
      WHERE deleted_at IS NULL
        AND scope IN ('super_admin', 'account_manager')`,
  );
};
