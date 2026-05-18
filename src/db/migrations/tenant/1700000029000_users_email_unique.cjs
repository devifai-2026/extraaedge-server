// Enforce unique email per tenant on `users`, case-insensitive, ignoring
// soft-deleted rows. Partial-unique-on-lower(email) was previously enforced
// only at the application layer in users.service.createUser, which is a TOCTOU
// race: two near-simultaneous create requests could both pass the
// findByEmail check and then both succeed. The index closes that hole.
//
// account_manager (new tenant-level role) doesn't need a schema change —
// users.role is a text column with no CHECK constraint, so it accepts the
// new value as soon as the app validates it.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uniq
      ON users (lower(email))
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS users_email_lower_uniq;`);
};
