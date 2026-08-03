// Grant the new 'accounts.bulk_import' tab — the Accounts-side importer for
// historical admissions migrated off a previous CRM (student + fee offer +
// EMI schedule + already-collected receipts, all from one spreadsheet).
//
// Seeded to account_manager and super_admin, matching the route gate in
// modules/bulk-admissions/routes.js. Idempotent jsonb merge, so per-tenant
// customisations to the rest of the matrix survive. New tenants pick it up
// from the provisioning seed via TENANT_TABS.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions || '{"accounts.bulk_import": "full"}'::jsonb,
            updated_at = now()
      WHERE scope IN ('account_manager', 'super_admin')
        AND NOT (tab_permissions ? 'accounts.bulk_import')`,
  );
};

exports.down = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions - 'accounts.bulk_import',
            updated_at = now()
      WHERE scope IN ('account_manager', 'super_admin')`,
  );
};
