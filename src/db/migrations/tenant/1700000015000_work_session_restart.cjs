// Marks a work_session row that was opened after the user already stopped
// for the day, so admins can see "manual restart" segments separately.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS restart_of_day boolean NOT NULL DEFAULT false;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE work_sessions DROP COLUMN IF EXISTS restart_of_day;`);
};
