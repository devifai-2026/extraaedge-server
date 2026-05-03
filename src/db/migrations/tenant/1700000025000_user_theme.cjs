// Per-user theme colors. NULL = use the system default (the existing
// brand red). Hex strings are validated at the API layer; we keep the
// column as plain text so future palette extensions don't need a
// migration.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN theme_primary text,
      ADD COLUMN theme_primary_dark text,
      ADD COLUMN theme_primary_light text,
      ADD COLUMN theme_preset text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS theme_preset,
      DROP COLUMN IF EXISTS theme_primary_light,
      DROP COLUMN IF EXISTS theme_primary_dark,
      DROP COLUMN IF EXISTS theme_primary;
  `);
};
