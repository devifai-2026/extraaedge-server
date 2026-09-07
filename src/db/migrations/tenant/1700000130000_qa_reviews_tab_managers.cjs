/* eslint-disable camelcase */
// Grant the QA scoring queue ('qa.reviews') to the manager tiers that can now
// actually use it.
//
// Until now qa-reviews' REVIEWER_ROLES was [qa, super_admin], and the tab was
// deliberately withheld from every manager tier because granting it would put
// a page in their sidebar that 403s on load. That changes here: a
// branch_manager reviews calls in their own branch and a telecaller_lead
// reviews their own telecallers', both narrowed server-side (applyBranch /
// applyReviewScope in modules/qa-reviews/routes.js).
//
// Also fixes a live inconsistency: telecaller_lead already carried
// 'qa.feedback' (it comes with the sales_manager-equivalent tab set) but was
// NOT in READER_ROLES, so the QA Feedback page appeared in their sidebar and
// then 403'd. The route side is fixed in the same release; nothing to change
// here for that tab since they already have it.
//
// sales_manager is deliberately NOT granted 'qa.reviews': it keeps read-only
// QA feedback but does not score.
//
// Idempotent — the guard skips a role that already holds the key.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  for (const scope of ['branch_manager', 'telecaller_lead']) {
    // eslint-disable-next-line no-await-in-loop
    await pgm.db.query(
      `UPDATE custom_roles
          SET tab_permissions = tab_permissions || '{"qa.reviews": "full"}'::jsonb,
              updated_at = now()
        WHERE scope = $1
          AND deleted_at IS NULL
          AND NOT (tab_permissions ? 'qa.reviews')`,
      [scope],
    );
  }
};

exports.down = async (pgm) => {
  for (const scope of ['branch_manager', 'telecaller_lead']) {
    // eslint-disable-next-line no-await-in-loop
    await pgm.db.query(
      `UPDATE custom_roles
          SET tab_permissions = tab_permissions - 'qa.reviews', updated_at = now()
        WHERE scope = $1 AND deleted_at IS NULL`,
      [scope],
    );
  }
};
