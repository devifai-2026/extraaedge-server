/* eslint-disable camelcase */
// Per-batch capstone: a capstone can target ONE batch or stay course-wide.
// batch_id NULL = applies to every batch of the program (the existing behavior,
// so all current capstones stay course-wide). When set, only that batch's
// students see/submit it.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE capstone_projects
      ADD COLUMN IF NOT EXISTS batch_id uuid REFERENCES batches(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS capstone_projects_batch_idx ON capstone_projects (batch_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE capstone_projects DROP COLUMN IF EXISTS batch_id;`);
};
