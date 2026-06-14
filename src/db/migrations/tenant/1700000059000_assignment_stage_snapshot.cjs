// Lead-transfer reporting: snapshot the lead's stage at the moment of each
// assignment/reassignment onto lead_assignments. Without this, "stage at the
// time of transfer" is lost once the new owner moves the lead forward — which
// is exactly the gap in the Telecaller→Counsellor handoff reports.
//
//   stage_id_at_transfer / sub_stage_id_at_transfer — the lead's stage when
//   this assignment row was created. Captured by the app on every assign /
//   reassign. Existing rows are backfilled from the lead's CURRENT stage as
//   the best available value (we can't reconstruct historical stage reliably).
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE lead_assignments
      ADD COLUMN IF NOT EXISTS stage_id_at_transfer     uuid REFERENCES lead_stages(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS sub_stage_id_at_transfer uuid REFERENCES lead_sub_stages(id) ON DELETE SET NULL;

    -- Backfill: best-effort from the lead's current stage. Only fills NULLs.
    UPDATE lead_assignments la
       SET stage_id_at_transfer     = l.stage_id,
           sub_stage_id_at_transfer = l.sub_stage_id
      FROM leads l
     WHERE la.lead_id = l.id
       AND la.stage_id_at_transfer IS NULL;

    -- Reporting indexes: by acting user + time, and by the new owner + time.
    CREATE INDEX IF NOT EXISTS lead_assignments_assigned_by_created_idx
      ON lead_assignments (assigned_by, created_at DESC);
    CREATE INDEX IF NOT EXISTS lead_assignments_from_user_created_idx
      ON lead_assignments (from_user_id, created_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP INDEX IF EXISTS lead_assignments_from_user_created_idx;
    DROP INDEX IF EXISTS lead_assignments_assigned_by_created_idx;
    ALTER TABLE lead_assignments
      DROP COLUMN IF EXISTS sub_stage_id_at_transfer,
      DROP COLUMN IF EXISTS stage_id_at_transfer;
  `);
};
