/* eslint-disable camelcase */
// Loss of Pay decided at APPROVAL time.
//
// Until now "is this leave paid?" was a property of the leave TYPE only, fixed
// when the employee applied. The approver needs to override it per request:
// approve the absence, but mark those days unpaid so payroll deducts them.
//
//   is_lop       null = follow the leave type; true/false = the approver's call
//   lop_days     how many of day_count are unpaid (supports approving a
//                3-day leave with only 1 day as LOP, and half-days at 0.5)
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE staff_leave
      ADD COLUMN IF NOT EXISTS is_lop     boolean,
      ADD COLUMN IF NOT EXISTS lop_days   numeric(5,2) NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS lop_note   text;
  `);

  // lop_days can never exceed the leave's own length, or payroll would deduct
  // days the person never took off.
  pgm.sql(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'staff_leave_lop_days_chk') THEN
        ALTER TABLE staff_leave ADD CONSTRAINT staff_leave_lop_days_chk
          CHECK (lop_days >= 0 AND (day_count IS NULL OR lop_days <= day_count));
      END IF;
    END $$;
  `);

  // Payroll's monthly LOP lookup: approved leave carrying unpaid days, by date.
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS staff_leave_lop_idx
      ON staff_leave (user_id, from_date, to_date)
      WHERE lop_days > 0 AND status = 'approved';
  `);

  // Backfill: leave already approved under an unpaid TYPE (LWP) is retro-marked
  // so payroll sees a consistent picture rather than two sources of truth.
  pgm.sql(`
    UPDATE staff_leave sl
       SET is_lop = true, lop_days = COALESCE(sl.day_count, 0)
      FROM leave_types lt
     WHERE lt.id = sl.leave_type_id
       AND lt.is_paid = false
       AND sl.status = 'approved'
       AND sl.is_lop IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS staff_leave_lop_idx;`);
  pgm.sql(`ALTER TABLE staff_leave DROP CONSTRAINT IF EXISTS staff_leave_lop_days_chk;`);
  pgm.sql(`
    ALTER TABLE staff_leave
      DROP COLUMN IF EXISTS is_lop,
      DROP COLUMN IF EXISTS lop_days,
      DROP COLUMN IF EXISTS lop_note;
  `);
};
