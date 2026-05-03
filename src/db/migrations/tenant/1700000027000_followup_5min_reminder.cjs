// Adds a second reminder timestamp on lead_followups so the scheduler can
// fire two reminders per follow-up — once at T-15min (existing
// reminder_sent_at column) and once again at T-5min (new column).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_followups
      ADD COLUMN IF NOT EXISTS reminder_5min_sent_at timestamptz;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_followups
      DROP COLUMN IF EXISTS reminder_5min_sent_at;
  `);
};
