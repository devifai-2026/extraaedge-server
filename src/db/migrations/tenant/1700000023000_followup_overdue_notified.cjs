// Track whether the overdue-followup notification fan-out has already
// fired for a follow-up so the scheduler doesn't re-spam the manager
// chain every minute. Separate from reminder_sent_at (which covers the
// 15-min "due soon" reminder).
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE lead_followups ADD COLUMN IF NOT EXISTS overdue_notified_at timestamptz;
    CREATE INDEX IF NOT EXISTS idx_lead_followups_overdue
      ON lead_followups (status, next_action_datetime, overdue_notified_at)
      WHERE deleted_at IS NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE lead_followups DROP COLUMN IF EXISTS overdue_notified_at;
  `);
};
