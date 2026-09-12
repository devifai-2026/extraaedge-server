/* eslint-disable camelcase */
// Let a class be marked as billable work.
//
// Payroll pays a trainer per EXTRA class and per DEMO class, so it has to be
// able to tell those apart from the regular timetable. `kind` already exists
// ('lecture' | 'mock_test') with no DB constraint; we add the two billable
// values and an is_billable flag.
//
// is_billable is separate from kind on purpose: an org may decide a particular
// lecture was extra work (a weekend make-up session) without reclassifying it,
// and payroll should count what the trainer was actually owed for, not what the
// timetable called it.
//
// Counting keys off ended_at — a class is billable when the trainer has marked
// it COMPLETE, never when it was merely scheduled. That is what stops payroll
// paying for a class that never happened.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE classes
      ADD COLUMN IF NOT EXISTS is_billable boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS billing_note text;
  `);
  // Partial index: payroll asks "which completed billable classes did this
  // trainer run in this month?" on every run.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS classes_billable_idx
      ON classes (trainer_id, ended_at)
      WHERE deleted_at IS NULL AND ended_at IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS classes_billable_idx;`);
  pgm.sql(`ALTER TABLE classes DROP COLUMN IF EXISTS is_billable, DROP COLUMN IF EXISTS billing_note;`);
};
