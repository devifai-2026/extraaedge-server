// Per-user working hours, used by the assignment rule processor when
// `assignment_rules.respect_working_hours = true`. We store one row per
// (user_id, day_of_week 0..6) so admins can shape per-day windows like
// Mon-Fri 09-18, Sat half-day, Sun off.
//
// Backfill: every existing user gets a default Mon-Sat 9:00-18:00, Sun closed
// schedule. Admins can edit later from User Profiles.
//
// `timezone` lives on the user row (we'll add a column too) so a counsellor
// in Bangalore and one in Dubai can both have "9 to 6" without admin math.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    -- Per-user timezone (defaults to Asia/Kolkata so existing users keep working)
    ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Kolkata';

    CREATE TABLE IF NOT EXISTS user_working_hours (
      user_id      uuid    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      day_of_week  integer NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
      is_open      boolean NOT NULL DEFAULT true,
      open_time    time,
      close_time   time,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, day_of_week)
    );

    -- Trigger to bump updated_at
    DROP TRIGGER IF EXISTS trg_user_working_hours_updated_at ON user_working_hours;
    CREATE TRIGGER trg_user_working_hours_updated_at
      BEFORE UPDATE ON user_working_hours
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Backfill defaults for every existing user that has no rows yet.
    -- Mon (1) — Sat (6): 09:00-18:00 open. Sun (0): closed.
    INSERT INTO user_working_hours (user_id, day_of_week, is_open, open_time, close_time)
    SELECT u.id, d.day, d.is_open, d.open_time::time, d.close_time::time
      FROM users u
      CROSS JOIN (
        VALUES
          (0, false, NULL,    NULL),
          (1, true,  '09:00', '18:00'),
          (2, true,  '09:00', '18:00'),
          (3, true,  '09:00', '18:00'),
          (4, true,  '09:00', '18:00'),
          (5, true,  '09:00', '18:00'),
          (6, true,  '09:00', '18:00')
      ) AS d(day, is_open, open_time, close_time)
     WHERE u.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM user_working_hours w WHERE w.user_id = u.id
       );
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS user_working_hours;
    ALTER TABLE users DROP COLUMN IF EXISTS timezone;
  `);
};
