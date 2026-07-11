/* eslint-disable camelcase */
// A class is taught by a specific trainer/head (classes.trainer_id), and a
// student's can't-attend / attending-online choice can carry a reason that the
// teaching team can see (attendance.reason).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE classes ADD COLUMN IF NOT EXISTS trainer_id uuid REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS classes_trainer_id_idx ON classes (trainer_id) WHERE deleted_at IS NULL;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS reason text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS classes_trainer_id_idx;
    ALTER TABLE classes DROP COLUMN IF EXISTS trainer_id;
    ALTER TABLE attendance DROP COLUMN IF EXISTS reason;
  `);
};
