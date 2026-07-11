/* eslint-disable camelcase */
// Phase G3 — interview slots gain an explicit start + end time (a window), and
// the same interview can be assigned to many students at once (each their own
// slot). `slot_at` stays as the legacy scheduled-start; backfill starts_at from
// it so existing slots keep their time.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE interview_slots ADD COLUMN IF NOT EXISTS starts_at timestamptz;
    ALTER TABLE interview_slots ADD COLUMN IF NOT EXISTS ends_at   timestamptz;
    UPDATE interview_slots SET starts_at = slot_at WHERE starts_at IS NULL AND slot_at IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE interview_slots DROP COLUMN IF EXISTS ends_at;
    ALTER TABLE interview_slots DROP COLUMN IF EXISTS starts_at;
  `);
};
