// Adds a completion_reason column to lead_followups.
//
// When a counsellor marks a follow-up done, the UI now prompts them for
// a free-text reason (e.g. "spoke to parent, decided to enrol"). The
// reason is stored on the follow-up row and surfaced in the LeadCard
// followups view, the Edit Lead form, and the lead timeline.
//
// Non-destructive: ADD COLUMN IF NOT EXISTS, no data writes.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE lead_followups
      ADD COLUMN IF NOT EXISTS completion_reason text;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE lead_followups
      DROP COLUMN IF EXISTS completion_reason;
  `);
};
