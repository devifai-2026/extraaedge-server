/* eslint-disable camelcase */
// One-time fix for leads stuck in '01-New' that already have a planned
// follow-up scheduled on them.
//
// Why: prior to this release, POST /follow-ups inserted the lead_followups
// row but never touched leads.stage_id. The result was leads showing
// "Stage: New / Not Called" while having an upcoming follow-up — a state
// the product owner correctly flagged as wrong for an admissions CRM.
// This migration brings the existing data in line with the new behaviour.
//
// What it does, per tenant:
//   1. Find all leads currently in '01-New' that have at least one planned,
//      non-deleted lead_followups row.
//   2. Move them to '04-Followup' (sub_stage = the Followup stage's default
//      sub-stage, or first sub-stage by order, or NULL if the tenant hasn't
//      configured any).
//   3. Drop a lead_activities row recording the auto-move so the timeline
//      reflects what happened.
//
// Tenants that don't have a '04-Followup' stage (custom pipeline) are
// skipped — the seed migration 1700000030000 guarantees its presence on
// every tenant going forward, but down-rev tenants can survive without it.

exports.up = (pgm) => {
  pgm.sql(`
    DO $backfill$
    DECLARE
      v_target_stage_id uuid;
      v_target_sub_stage_id uuid;
      v_new_stage_id uuid;
      v_moved integer := 0;
    BEGIN
      SELECT id INTO v_target_stage_id
        FROM lead_stages
       WHERE code = '04-Followup' AND deleted_at IS NULL AND is_active
       LIMIT 1;

      IF v_target_stage_id IS NULL THEN
        RAISE NOTICE 'backfill: no 04-Followup stage in this tenant — skipping';
        RETURN;
      END IF;

      SELECT id INTO v_new_stage_id
        FROM lead_stages
       WHERE code = '01-New' AND deleted_at IS NULL
       LIMIT 1;

      IF v_new_stage_id IS NULL THEN
        RAISE NOTICE 'backfill: no 01-New stage in this tenant — skipping';
        RETURN;
      END IF;

      -- Default sub-stage for the Followup target. Prefer is_default rows;
      -- fall back to first by order_index/name. NULL is fine.
      SELECT id INTO v_target_sub_stage_id
        FROM lead_sub_stages
       WHERE stage_id = v_target_stage_id
         AND deleted_at IS NULL
         AND is_active
       ORDER BY is_default DESC, order_index, name
       LIMIT 1;

      -- Move the leads. Identify them by stage_id + existence of a planned
      -- follow-up so we don't disturb leads whose follow-ups were already
      -- completed.
      WITH stuck AS (
        SELECT DISTINCT l.id
          FROM leads l
          JOIN lead_followups f ON f.lead_id = l.id
         WHERE l.stage_id = v_new_stage_id
           AND l.deleted_at IS NULL
           AND f.status = 'planned'
           AND f.deleted_at IS NULL
      ),
      updated AS (
        UPDATE leads
           SET stage_id        = v_target_stage_id,
               sub_stage_id    = v_target_sub_stage_id,
               last_activity_at = now()
         WHERE id IN (SELECT id FROM stuck)
        RETURNING id
      )
      INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json, created_at)
      SELECT
        id,
        NULL,
        'stage_changed',
        'Stage auto-moved to Followup (backfill: had a planned follow-up while still in New)',
        jsonb_build_object(
          'from', v_new_stage_id,
          'to', v_target_stage_id,
          'to_sub', v_target_sub_stage_id,
          'reason', 'backfill_follow_up_scheduled_on_new'
        ),
        now()
      FROM updated;

      GET DIAGNOSTICS v_moved = ROW_COUNT;
      RAISE NOTICE 'backfill: moved % lead(s) from New → Followup', v_moved;
    END
    $backfill$;
  `);
};

exports.down = (pgm) => {
  // Reverting the backfill would re-introduce the inconsistent state we
  // just cleaned up. No-op.
  pgm.sql(`SELECT 1`);
};
