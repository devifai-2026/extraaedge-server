// Adds a reschedule_reason column to lead_followups, mirroring
// completion_reason (1700000034000) — same pattern, for the reschedule
// flow instead of the mark-done flow. Holds the most recent reschedule's
// remark; full reschedule-by-reschedule history lives in lead_activities
// (type='follow_up_rescheduled'), which already gets one row per
// reschedule and now also carries the reason + the date it moved from.
//
// Non-destructive: ADD COLUMN IF NOT EXISTS, no data writes.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE lead_followups
      ADD COLUMN IF NOT EXISTS reschedule_reason text;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE lead_followups
      DROP COLUMN IF EXISTS reschedule_reason;
  `);
};
