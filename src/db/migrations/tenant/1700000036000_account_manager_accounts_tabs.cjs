// The account_manager role used to share tabs with counsellors (dashboard,
// leads, followups, whatsapp). Now that the Accounts module exists, we
// swap their tab_permissions to point at the new accounts.* keys. The
// sidebar + RBAC fall back to the bucket in lib/rbac.js only when
// allowed_tabs is unset; this migration makes sure the *persisted*
// tab_permissions in custom_roles tells the truth too — otherwise the
// JWT carries the old keys forever.
//
// Idempotent: WHERE scope = 'account_manager' AND tab_permissions does
// not already contain 'accounts.dashboard'. Re-running is a no-op.

exports.shorthands = undefined;

const NEW_TABS = {
  'accounts.dashboard': 'full',
  'accounts.this_month_admissions': 'full',
  'accounts.total_admissions': 'full',
  'accounts.approvals': 'full',
  'accounts.attendings': 'full',
  'accounts.break': 'full',
  'accounts.report': 'full',
  'accounts.pay_schedule': 'full',
  'accounts.collection_receipt_wise': 'full',
};

exports.up = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = $1::jsonb,
            updated_at = now()
      WHERE scope = 'account_manager'
        AND NOT (tab_permissions ? 'accounts.dashboard')`,
    [JSON.stringify(NEW_TABS)],
  );
};

exports.down = async (pgm) => {
  // Roll back to the legacy shared tabs the bucket used to grant.
  const OLD = {
    dashboard: 'full',
    leads: 'full',
    followups: 'full',
    whatsapp: 'full',
  };
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = $1::jsonb,
            updated_at = now()
      WHERE scope = 'account_manager'`,
    [JSON.stringify(OLD)],
  );
};
