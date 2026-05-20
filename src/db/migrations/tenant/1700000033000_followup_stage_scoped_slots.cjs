// Re-scopes the 5 follow-up slots from per-lead to per-(lead, stage).
//
// Before this migration: a lead had up to 5 slot rows (slot_index 1..5),
// scoped by lead_id only — the partial index `lead_followups_lead_slot_idx`
// was on (lead_id, slot_index).
// After this migration: a lead can have up to 5 slot rows PER STAGE. The
// index moves to (lead_id, stage_id, slot_index). Uniqueness is NOT
// enforced at the DB level (kept non-unique so the migration is safe
// against any pre-existing duplicates); the app layer enforces
// one-row-per-(lead, stage, slot).
//
// Strictly non-destructive: no rows are deleted, no columns dropped, no
// data overwritten. The only data write is a backfill that fills
// stage_id ONLY where it is NULL on existing slot rows — uses the
// lead's current stage_id as the best available scope for legacy slot
// rows that pre-date stage scoping. Rows that already had stage_id set
// (e.g. those inserted by the stage-change handler) are left untouched.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    -- 1. Drop the old per-lead partial index. Index only, no row data.
    DROP INDEX IF EXISTS lead_followups_lead_slot_idx;

    -- 2. Backfill stage_id on legacy slot rows. ONLY fills NULLs; never
    --    overwrites an existing stage_id. For legacy slot rows we use
    --    the lead's *current* stage_id — it's the closest scope we have
    --    for rows that pre-date stage scoping. Ad-hoc followups
    --    (slot_index IS NULL) are left alone so we don't accidentally
    --    re-scope rows that were intentionally lead-scoped only.
    UPDATE lead_followups f
       SET stage_id = l.stage_id
      FROM leads l
     WHERE f.lead_id = l.id
       AND f.stage_id IS NULL
       AND f.slot_index IS NOT NULL
       AND f.deleted_at IS NULL
       AND l.stage_id IS NOT NULL;

    -- 3. New partial index, scoped per-(lead, stage). Non-unique on
    --    purpose: if any tenant's data has pre-existing duplicates on
    --    the new key the index still creates cleanly. App-layer
    --    enforcement (repo upsert + replaceFollowupsForStage) keeps
    --    new writes one-per-slot.
    CREATE INDEX IF NOT EXISTS lead_followups_lead_stage_slot_idx
        ON lead_followups (lead_id, stage_id, slot_index)
        WHERE deleted_at IS NULL AND slot_index IS NOT NULL;

    -- 4. Going-forward constraint: slot rows must carry stage_id.
    --    NOT VALID = enforce on new INSERT/UPDATE only, don't re-scan
    --    existing rows. We then VALIDATE; the backfill above ensures
    --    every current slot row passes.
    ALTER TABLE lead_followups
        DROP CONSTRAINT IF EXISTS lead_followups_slot_requires_stage;

    ALTER TABLE lead_followups
        ADD CONSTRAINT lead_followups_slot_requires_stage
        CHECK (slot_index IS NULL OR stage_id IS NOT NULL) NOT VALID;

    ALTER TABLE lead_followups
        VALIDATE CONSTRAINT lead_followups_slot_requires_stage;
  `);
};

exports.down = async (pgm) => {
  // Reverse only the structural pieces. The backfill is intentionally
  // NOT undone — the values written were correct stage scoping, and
  // unsetting them would be data destruction.
  await pgm.db.query(`
    ALTER TABLE lead_followups
        DROP CONSTRAINT IF EXISTS lead_followups_slot_requires_stage;

    DROP INDEX IF EXISTS lead_followups_lead_stage_slot_idx;

    CREATE INDEX IF NOT EXISTS lead_followups_lead_slot_idx
        ON lead_followups (lead_id, slot_index)
        WHERE deleted_at IS NULL AND slot_index IS NOT NULL;
  `);
};
