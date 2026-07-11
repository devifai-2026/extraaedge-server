/* eslint-disable camelcase */
// Fix: a trainer legitimately has one course-level row (module_id NULL) PLUS
// one row per module they teach — all role='trainer'. The earlier
// (program_id, user_id, role) unique index wrongly collapsed those into a
// duplicate. Re-key uniqueness to include module_id (NULLs treated distinct
// enough via COALESCE) so course-level + per-module rows coexist, while still
// blocking exact duplicates.
exports.up = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS course_trainers_user_role_uq;`);
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS course_trainers_user_role_module_uq
      ON course_trainers (program_id, user_id, role, (COALESCE(module_id, '00000000-0000-0000-0000-000000000000'::uuid)))
      WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS course_trainers_user_role_module_uq;`);
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS course_trainers_user_role_uq
      ON course_trainers (program_id, user_id, role) WHERE deleted_at IS NULL;
  `);
};
