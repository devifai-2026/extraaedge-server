/* eslint-disable camelcase */
// The 24-hour class completion rule.
//
// A trainer marks a class complete; that mark is what makes it payable. If it
// is still unmarked 24 hours after the class was due to end, the system records
// it as NOT conducted — and stops paying for it — after a reminder has gone out.
// A branch manager can override that verdict either way.
//
//   completion_status  pending | completed | not_conducted
//   completion_due_at  ends_at + the grace window; the worker keys off this
//   auto_marked_at     set when the SYSTEM decided, not the trainer
//   override_by        set when a BM overrode the system or the trainer
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE classes
      ADD COLUMN IF NOT EXISTS completion_status   text NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS completion_due_at   timestamptz,
      ADD COLUMN IF NOT EXISTS completion_note     text,
      ADD COLUMN IF NOT EXISTS completion_reminded_at timestamptz,
      ADD COLUMN IF NOT EXISTS auto_marked_at      timestamptz,
      ADD COLUMN IF NOT EXISTS override_by         uuid REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS override_at         timestamptz;
  `);

  pgm.sql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'classes_completion_status_chk') THEN
        ALTER TABLE classes ADD CONSTRAINT classes_completion_status_chk
          CHECK (completion_status IN ('pending','completed','not_conducted'));
      END IF;
    END $$;
  `);

  // Backfill: a class already carrying ended_at was completed by its trainer
  // under the old flow, so it keeps paying. Everything else starts pending.
  pgm.sql(`
    UPDATE classes
       SET completion_status = 'completed'
     WHERE deleted_at IS NULL AND ended_at IS NOT NULL AND completion_status = 'pending';
  `);

  // Every class gets a deadline, existing rows included, so the worker has a
  // consistent field to sweep rather than recomputing the window per row.
  pgm.sql(`
    UPDATE classes
       SET completion_due_at = ends_at + interval '24 hours'
     WHERE deleted_at IS NULL AND completion_due_at IS NULL AND ends_at IS NOT NULL;
  `);

  // The worker's sweep: overdue and still pending. Partial, so it stays small
  // however many classes the tenant accumulates.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS classes_completion_due_idx
      ON classes (completion_due_at)
      WHERE deleted_at IS NULL AND completion_status = 'pending';
  `);

  // Payroll counts billable classes the trainer actually completed. Replaces
  // the ended_at-only index from 1700000142000, which would have paid for a
  // class the system later marked not conducted.
  pgm.sql(`DROP INDEX IF EXISTS classes_billable_idx;`);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS classes_billable_idx
      ON classes (trainer_id, ends_at)
      WHERE deleted_at IS NULL AND is_billable IS TRUE AND completion_status = 'completed';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS classes_completion_due_idx;`);
  pgm.sql(`DROP INDEX IF EXISTS classes_billable_idx;`);
  pgm.sql(`ALTER TABLE classes DROP CONSTRAINT IF EXISTS classes_completion_status_chk;`);
  pgm.sql(`
    ALTER TABLE classes
      DROP COLUMN IF EXISTS completion_status, DROP COLUMN IF EXISTS completion_due_at,
      DROP COLUMN IF EXISTS completion_note, DROP COLUMN IF EXISTS completion_reminded_at,
      DROP COLUMN IF EXISTS auto_marked_at, DROP COLUMN IF EXISTS override_by,
      DROP COLUMN IF EXISTS override_at;
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS classes_billable_idx
      ON classes (trainer_id, ended_at)
      WHERE deleted_at IS NULL AND ended_at IS NOT NULL;
  `);
};
