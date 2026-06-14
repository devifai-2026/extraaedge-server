// Allow follow-up rows (including stage-scoped slots) to carry a comment
// WITHOUT a date.
//
// Why: the Edit Lead form lets a counsellor type a "Comment N" for a slot
// (or the top "Follow up Comments") without picking a "Next Action Date".
// Previously next_action_datetime was NOT NULL, so any such comment-only
// row was silently dropped on save — the typed comment vanished. Product
// rule is now "store exactly what the user typed", so a slot is persisted
// when it has a date OR a comment.
//
// Strictly structural + non-destructive: only relaxes a NOT NULL. No rows
// touched, no data rewritten. The slot_requires_stage CHECK is untouched —
// slot rows still must carry stage_id.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE lead_followups
      ALTER COLUMN next_action_datetime DROP NOT NULL;

    -- A slot row must carry at least one of: a date or a comment. Prevents
    -- fully-empty slot rows from being written. NOT VALID so we don't
    -- re-scan history (every existing row has a date, so all pass anyway),
    -- then VALIDATE to enforce going forward.
    ALTER TABLE lead_followups
      DROP CONSTRAINT IF EXISTS lead_followups_slot_has_date_or_comment;

    ALTER TABLE lead_followups
      ADD CONSTRAINT lead_followups_slot_has_date_or_comment
      CHECK (
        slot_index IS NULL
        OR next_action_datetime IS NOT NULL
        OR (comment IS NOT NULL AND length(btrim(comment)) > 0)
      ) NOT VALID;

    ALTER TABLE lead_followups
      VALIDATE CONSTRAINT lead_followups_slot_has_date_or_comment;
  `);
};

exports.down = async (pgm) => {
  // Re-adding NOT NULL would fail if any comment-only rows now exist, so the
  // down path drops the new constraint and only re-applies NOT NULL when it
  // is safe to do so.
  await pgm.db.query(`
    ALTER TABLE lead_followups
      DROP CONSTRAINT IF EXISTS lead_followups_slot_has_date_or_comment;

    UPDATE lead_followups
       SET next_action_datetime = COALESCE(next_action_datetime, created_at, now())
     WHERE next_action_datetime IS NULL;

    ALTER TABLE lead_followups
      ALTER COLUMN next_action_datetime SET NOT NULL;
  `);
};
