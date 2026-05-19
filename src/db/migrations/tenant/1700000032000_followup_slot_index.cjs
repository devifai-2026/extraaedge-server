/* eslint-disable camelcase */
// Adds an optional `slot_index` integer to lead_followups.
//
// Why: bulk import + manual lead form let the user fill up to 5 named slots
// (next_action_date_1..5 / comment_1..5). The product spec is that the UI
// renders those slots in the same numbered order the user typed them in
// — not date-sorted — because users routinely enter attempts out of
// chronological order when reconstructing history.
//
// Schema choice: nullable smallint with a 1..5 CHECK. NULL means "this
// follow-up wasn't created from a slot" (e.g. ad-hoc follow-up scheduled
// from the LeadCard menu). The FE filters slot rows with slot_index IS NOT
// NULL when rendering the 5-slot view.
//
// We also index it scoped to (lead_id, slot_index) so the LeadCard query
// stays cheap; non-slot rows are excluded from the index entirely.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_followups
      ADD COLUMN IF NOT EXISTS slot_index smallint
        CHECK (slot_index IS NULL OR (slot_index >= 1 AND slot_index <= 5));

    -- Only slot rows go into this index; ad-hoc follow-ups stay out.
    CREATE INDEX IF NOT EXISTS lead_followups_lead_slot_idx
      ON lead_followups (lead_id, slot_index)
      WHERE deleted_at IS NULL AND slot_index IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS lead_followups_lead_slot_idx;
    ALTER TABLE lead_followups DROP COLUMN IF EXISTS slot_index;
  `);
};
