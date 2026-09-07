/* eslint-disable camelcase */
// Withhold the aggregate QA Feedback report from telecaller_lead.
//
// A telecaller_lead scores its OWN telecallers' calls (it is in qa-reviews
// REVIEWER_ROLES, narrowed by applyReviewScope). The 'qa.feedback' report is
// the cross-team scorecard read-back and belongs to the tiers above it —
// sales_manager, branch_manager, qa, super_admin — so telecaller_lead is not
// in READER_ROLES.
//
// The tab arrived by inheritance: telecaller_lead's grant is built from the
// sales_manager-equivalent set, which includes 'qa.feedback'. Left in place it
// would put a page in the sidebar that the routes reject — the same
// tab-without-route mismatch 1700000130000 was written to fix, in the other
// direction.
//
// A separate migration rather than an edit to 1700000130000: that one has
// already been applied, so amending it would never re-run.
//
// Idempotent — guarded on the key being present.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions - 'qa.feedback', updated_at = now()
      WHERE scope = 'telecaller_lead'
        AND deleted_at IS NULL
        AND (tab_permissions ? 'qa.feedback')`,
  );
};

exports.down = async (pgm) => {
  await pgm.db.query(
    `UPDATE custom_roles
        SET tab_permissions = tab_permissions || '{"qa.feedback": "full"}'::jsonb,
            updated_at = now()
      WHERE scope = 'telecaller_lead'
        AND deleted_at IS NULL
        AND NOT (tab_permissions ? 'qa.feedback')`,
  );
};
