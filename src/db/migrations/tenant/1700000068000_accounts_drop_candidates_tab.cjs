// Grant the new 'accounts.drop_candidates' tab to every existing
// account_manager role. Idempotent jsonb merge — preserves per-tenant tweaks.
// super_admin / branch_manager get the wildcard '*' at login so they don't
// need an explicit grant. New tenants pick it up via DEFAULT_TAB_KEYS.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions || '{"accounts.drop_candidates": "full"}'::jsonb,
            updated_at = now()
      WHERE scope = 'account_manager'
        AND NOT (tab_permissions ? 'accounts.drop_candidates')`,
  );
};

exports.down = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions - 'accounts.drop_candidates',
            updated_at = now()
      WHERE scope = 'account_manager'`,
  );
};
