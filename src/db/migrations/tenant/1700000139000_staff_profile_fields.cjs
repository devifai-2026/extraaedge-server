/* eslint-disable camelcase */
// Staff profile fields the HR suite needs, on users.
//
// personal_email is the one that matters most. `users.email` is the OFFICIAL /
// login address — it is citext NOT NULL UNIQUE and is referenced by auth,
// invites and every lookup, so it cannot be repurposed. The personal address is
// a second, separate column because onboarding credentials and the offer letter
// have to reach someone BEFORE their work account exists.
//
// Deliberately nullable and NOT unique:
//   - nullable, because existing staff have no personal address on file and
//     backfilling a guess would be worse than leaving it blank;
//   - not unique, because two people can legitimately share one (a couple, a
//     family address) and a UNIQUE constraint would block a real hire for no
//     security benefit — it is never a login identifier.
//
// joining_date and dob support payroll (pro-rata in the joining month) and the
// birthday/anniversary surfaces; employee_code is the human-facing staff id HR
// teams use on payslips and registers.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS personal_email citext,
      ADD COLUMN IF NOT EXISTS joining_date   date,
      ADD COLUMN IF NOT EXISTS dob            date,
      ADD COLUMN IF NOT EXISTS employee_code  text;
  `);
  // Unique only when present, and only among live rows, so blanks never collide
  // and a soft-deleted leaver does not hold their code hostage.
  pgm.sql(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_employee_code_uniq
      ON users (employee_code)
      WHERE employee_code IS NOT NULL AND deleted_at IS NULL;
  `);
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS users_personal_email_idx
      ON users (personal_email)
      WHERE personal_email IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS users_employee_code_uniq;`);
  pgm.sql(`DROP INDEX IF EXISTS users_personal_email_idx;`);
  pgm.sql(`
    ALTER TABLE users
      DROP COLUMN IF EXISTS personal_email,
      DROP COLUMN IF EXISTS joining_date,
      DROP COLUMN IF EXISTS dob,
      DROP COLUMN IF EXISTS employee_code;
  `);
};
