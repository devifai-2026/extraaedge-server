/* eslint-disable camelcase */
// Disbursement scheduling + reminders + completion notification.
//
// Three things the payroll run could not express before:
//   1. WHEN salary is due    -> payroll_runs.pay_date (+ a tenant default day)
//   2. Reminders before it   -> payroll_reminders, one row per (run, offset)
//                               so a reminder can never fire twice
//   3. "everyone is paid"    -> payroll_runs.completed_notified_at, set once,
//                               which is what makes the admin/BM notification
//                               exactly-once rather than once-per-payslip.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE payroll_runs
      ADD COLUMN IF NOT EXISTS pay_date date,
      ADD COLUMN IF NOT EXISTS completed_notified_at timestamptz,
      ADD COLUMN IF NOT EXISTS paid_count int NOT NULL DEFAULT 0;
  `);

  // Per-disbursement schedule. Usually equal to the run's pay_date, but kept
  // per row because a held salary (dispute, pending clearance) gets paid later
  // than the rest of the run without moving everyone else's date.
  pgm.sql(`
    ALTER TABLE payroll_disbursements
      ADD COLUMN IF NOT EXISTS scheduled_date date,
      ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;
  `);

  // One row per reminder we intend to send. UNIQUE (run_id, offset_days) is
  // the idempotency guard: the worker can run every hour, or twice, and a
  // reminder still goes out exactly once.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS payroll_reminders (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id       uuid NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
      offset_days  int NOT NULL,
      due_on       date NOT NULL,
      kind         text NOT NULL DEFAULT 'upcoming',
      status       text NOT NULL DEFAULT 'pending',
      sent_at      timestamptz,
      recipients   jsonb NOT NULL DEFAULT '[]'::jsonb,
      note         text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payroll_reminders_kind_chk
        CHECK (kind IN ('upcoming','due_today','overdue','completed')),
      CONSTRAINT payroll_reminders_status_chk
        CHECK (status IN ('pending','sent','skipped','failed')),
      UNIQUE (run_id, offset_days, kind)
    );
    CREATE INDEX IF NOT EXISTS payroll_reminders_due_idx
      ON payroll_reminders (status, due_on);
  `);

  // Tenant-level payroll policy: which day of the month salary is due and how
  // many days ahead to warn. Single row, id enforced so it cannot fan out.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS payroll_settings (
      id                   int PRIMARY KEY DEFAULT 1,
      pay_day_of_month     int NOT NULL DEFAULT 1,
      reminder_offsets     jsonb NOT NULL DEFAULT '[3,1,0]'::jsonb,
      notify_on_complete   boolean NOT NULL DEFAULT true,
      updated_by           uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_at           timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT payroll_settings_single CHECK (id = 1),
      CONSTRAINT payroll_settings_day_chk CHECK (pay_day_of_month BETWEEN 1 AND 28)
    );
    INSERT INTO payroll_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS payroll_reminders, payroll_settings;`);
  pgm.sql(`
    ALTER TABLE payroll_disbursements
      DROP COLUMN IF EXISTS scheduled_date,
      DROP COLUMN IF EXISTS reminder_sent_at;
    ALTER TABLE payroll_runs
      DROP COLUMN IF EXISTS pay_date,
      DROP COLUMN IF EXISTS completed_notified_at,
      DROP COLUMN IF EXISTS paid_count;
  `);
};
