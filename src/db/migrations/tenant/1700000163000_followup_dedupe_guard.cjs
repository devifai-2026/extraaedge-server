/* eslint-disable camelcase */

// Guard against duplicate follow-ups created by a double-submit.
//
// SYMPTOM: leads were showing the same follow-up twice in the Follow-up
// Manager — identical lead, minute, comment and owner. Inspecting the data
// showed pairs of rows sharing an exact created_at down to the second, i.e.
// one user action that reached the insert twice (double click, retried
// request), not two real attempts.
//
// The insert paths (POST /follow-ups, the ad-hoc upsert, call logging) had no
// idempotency guard, so nothing stopped the second write. A DB-level index is
// the right place for this: it holds no matter which path inserts, including
// the workers and future callers that would otherwise each need their own
// check.
//
// SCOPE — deliberately narrow, so this cannot reject legitimate work:
//   • only rows that are still OPEN (status='planned'). A lead may genuinely
//     have many completed attempts; what it must not have is two identical
//     open ones racing each other.
//   • only live rows (deleted_at IS NULL), so soft-deleting frees the key and
//     rescheduling to the same time later still works.
//   • keyed on the RAW next_action_datetime.
//
//     This was first written as date_trunc('minute', ...) on the theory that
//     duplicates differ by milliseconds. Two things make the raw column the
//     right key instead:
//       1. date_trunc(text, timestamptz) is STABLE, not IMMUTABLE — it depends
//          on the session TimeZone — so Postgres rejects it in an index
//          expression outright ("functions in index expression must be marked
//          IMMUTABLE"). The migration could not be created at all.
//       2. It was unnecessary: the duplicate rows share an EXACT timestamp,
//          because both inserts carry the same client-supplied datetime.
//          Checked against live data — minute-truncated and raw-timestamp
//          grouping find the identical 17 duplicate groups.
//     The raw column is therefore both valid in an index and exactly as
//     effective. The narrower key is also safer: it can only ever reject rows
//     that collide to the microsecond.
//
// Completed history (status='done'/'missed'/'cancelled') is deliberately NOT
// covered — a lead legitimately accumulates many closed attempts, and those
// rows are what the timeline is built from.

exports.up = (pgm) => {
  // Soft-delete pre-existing duplicate OPEN rows, keeping the earliest of each
  // identical group. Without this the unique index below cannot be created.
  // Only touches status='planned' rows that are identical on the key —
  // completed history is never modified.
  pgm.sql(`
    UPDATE lead_followups f
       SET deleted_at = now(), updated_at = now()
     WHERE f.deleted_at IS NULL
       AND f.status = 'planned'
       AND EXISTS (
         SELECT 1 FROM lead_followups k
          WHERE k.deleted_at IS NULL
            AND k.status = 'planned'
            AND k.lead_id = f.lead_id
            AND k.next_action_datetime IS NOT DISTINCT FROM f.next_action_datetime
            AND COALESCE(k.comment, '') = COALESCE(f.comment, '')
            AND (k.created_at < f.created_at OR (k.created_at = f.created_at AND k.id < f.id))
       )
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX lead_followups_no_dup_open
        ON lead_followups (
             lead_id,
             next_action_datetime,
             (COALESCE(comment, ''))
           )
     WHERE deleted_at IS NULL AND status = 'planned'
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS lead_followups_no_dup_open`);
};
