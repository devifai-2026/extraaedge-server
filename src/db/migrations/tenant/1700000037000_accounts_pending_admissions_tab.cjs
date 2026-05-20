// Add the new 'accounts.pending_admissions' tab to every account_manager
// role that already exists. Idempotent — uses jsonb || to merge without
// overwriting any per-tenant customisations.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions || '{"accounts.pending_admissions": "full"}'::jsonb,
            updated_at = now()
      WHERE scope = 'account_manager'
        AND NOT (tab_permissions ? 'accounts.pending_admissions')`,
  );
};

exports.down = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions - 'accounts.pending_admissions',
            updated_at = now()
      WHERE scope = 'account_manager'`,
  );
};
