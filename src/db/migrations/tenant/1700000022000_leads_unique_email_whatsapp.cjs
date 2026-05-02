// Enforce per-tenant uniqueness on lead email and whatsapp_number. Partial
// indexes so (a) leads without an email/whatsapp don't collide on NULL,
// and (b) soft-deleted leads don't block re-use of the same address.
// Email is citext so the unique check is case-insensitive automatically.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS leads_email_unique
      ON leads (email)
      WHERE email IS NOT NULL AND deleted_at IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS leads_whatsapp_unique
      ON leads (whatsapp_number)
      WHERE whatsapp_number IS NOT NULL AND deleted_at IS NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP INDEX IF EXISTS leads_email_unique;
    DROP INDEX IF EXISTS leads_whatsapp_unique;
  `);
};
