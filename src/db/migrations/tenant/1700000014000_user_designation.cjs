// Free-text "official designation" for users (separate from access-level role).
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS designation text;`);
};

exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE users DROP COLUMN IF EXISTS designation;`);
};
