// Give the account_manager role the WhatsApp tab.
//
// Migration 1700000036000 swapped account_manager tabs to the accounts.* keys
// and dropped 'whatsapp'. The accounts team now needs WhatsApp visibility (they
// see ALL conversations), so add the 'whatsapp' tab back to their persisted
// tab_permissions. Idempotent: only adds the key if missing.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions || '{"whatsapp":"full"}'::jsonb,
            updated_at = now()
      WHERE scope = 'account_manager'
        AND NOT (tab_permissions ? 'whatsapp')`,
  );
};

exports.down = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions - 'whatsapp',
            updated_at = now()
      WHERE scope = 'account_manager'`,
  );
};
