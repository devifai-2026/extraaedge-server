// Remove the working-hours / availability concept entirely. Product
// decision: assignments fire 24/7. We no longer want the columns or tables
// in the schema.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS user_working_hours;
    DROP TABLE IF EXISTS user_availability;
    ALTER TABLE users DROP COLUMN IF EXISTS timezone;
    ALTER TABLE assignment_rules DROP COLUMN IF EXISTS respect_working_hours;
    ALTER TABLE assignment_rules DROP COLUMN IF EXISTS skip_unavailable;
  `);
};

exports.down = async () => {
  // No-op. Working hours were removed by product decision; we do not
  // restore them on rollback. If you need to bring them back, revert the
  // commit that removed them so the original CREATE TABLE statements run.
};
