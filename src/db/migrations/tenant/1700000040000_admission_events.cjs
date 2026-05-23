/* eslint-disable camelcase */
// Audit timeline for admissions.
//
// Why: the FE "Admission Timeline" tab + the admin pipeline overview both
// want a chronological list of "what happened to this admission" — created,
// status changes (pending_approval → attending → on_break → completed /
// rejected), receipts, photo uploads, edits. The admissions table itself
// has `status` + `updated_at` but no history, so we emit append-only rows
// here from the service layer on every write.
//
// Backfill: for every existing admission we insert one `created` row so
// the timeline isn't empty for current data. From now on, the service
// layer emits an event per mutation.
//
// `metadata` is jsonb so we can stash freeform context per event_type
// (e.g. fields changed on `field_edited`, amount/mode_of_payment on
// `receipt_added`) without schema churn.

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS admission_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admission_id uuid NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
      lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
      event_type text NOT NULL,
      prev_status text,
      next_status text,
      actor_user_id uuid,
      actor_kind text NOT NULL DEFAULT 'system',
      summary text,
      metadata jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS idx_admission_events_admission
      ON admission_events (admission_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admission_events_lead
      ON admission_events (lead_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admission_events_type
      ON admission_events (event_type, occurred_at DESC);

    -- Backfill: every existing admission gets a synthetic 'created' event
    -- at its created_at so the timeline isn't blank for legacy rows.
    INSERT INTO admission_events (admission_id, lead_id, event_type, next_status, actor_user_id, actor_kind, summary, occurred_at)
    SELECT a.id, a.lead_id, 'created', a.status, a.created_by, 'system',
           'Admission record created (backfilled)', a.created_at
      FROM admissions a
     WHERE a.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM admission_events e
          WHERE e.admission_id = a.id AND e.event_type = 'created'
       );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS admission_events;`);
};
