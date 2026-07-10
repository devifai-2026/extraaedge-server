/* eslint-disable camelcase */
// A course can have MULTIPLE head trainers (decided). Drop the one-head-per-
// course partial unique index added in the LMS foundation migration. We still
// avoid duplicate (program, user) head rows via a guard in the service.
exports.up = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS course_trainers_one_head;`);
  // Prevent the same user being added twice with the same role on a course
  // (idempotent assignment) — but allow many distinct heads.
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS course_trainers_user_role_uq
      ON course_trainers (program_id, user_id, role)
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS course_trainers_user_role_uq;`);
  // (We don't recreate the one-head index on rollback — multi-head is the
  // intended model going forward.)
};
