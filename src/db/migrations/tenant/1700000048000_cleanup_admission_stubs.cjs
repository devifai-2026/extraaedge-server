/* eslint-disable camelcase */
// One-shot cleanup: soft-delete admission stubs that were auto-created
// by the old `ensureFromConvertedLead` hook on lead conversion. That
// hook is no longer wired (see leads/service.changeStage), but a tenant
// can still have leftover stubs sitting in 'pending_approval' status
// that confuse the Pending Admissions queue (they show "Verify &
// Approve" on rows the student never submitted).
//
// Stub heuristic — we soft-delete when ALL of the following hold:
//   • status = 'pending_approval'
//   • approved_by IS NULL              (nobody has touched it)
//   • total_fees = 0                   (no fee plan locked in)
//   • no rows in admission_education   (no qualification data)
//   • no rows in admission_receipts    (no money captured)
//
// Soft-delete (set deleted_at) keeps the audit trail intact; a power
// user can restore via SQL if they really want it back.

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE admissions a
       SET deleted_at = now(),
           updated_at = now()
     WHERE a.deleted_at IS NULL
       AND a.status = 'pending_approval'
       AND a.approved_by IS NULL
       AND COALESCE(a.total_fees, 0) = 0
       AND NOT EXISTS (
         SELECT 1 FROM admission_education e
          WHERE e.admission_id = a.id
       )
       AND NOT EXISTS (
         SELECT 1 FROM admission_receipts r
          WHERE r.admission_id = a.id AND r.deleted_at IS NULL
       );
  `);
};

exports.down = () => {
  // No-op. Restoring soft-deleted stubs blindly would re-poison the
  // Pending Admissions queue; if a tenant really needs a specific row
  // back, do it manually with the row's id.
};
