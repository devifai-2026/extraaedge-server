/* eslint-disable camelcase */
// Three roles authorized for an endpoint but with no tab to render it.
//
// Each is a one-key grant against a route that ALREADY admits the role, so
// nothing new is exposed — this only closes the gap between "the API lets you"
// and "the sidebar shows you".
//
//   qa              -> qa.feedback
//     READER_ROLES in modules/qa-reviews includes qa, so GET /qa-reviews/summary
//     already returns 200 for them. Without the tab, the reviewer who produces
//     every scorecard cannot read their own output back.
//
//   telecaller_lead -> qa.feedback
//     It scores its team's calls but was the one manager tier denied the
//     aggregate report.
//
//   head_trainer    -> lms.analytics
//     It owns the trainer roster and the batches, but lms.analytics was granted
//     to super_admin + branch_manager only, so the person who actually manages
//     trainers could not see trainer analytics.
//
// Idempotent per key; a per-tenant custom level is never overwritten.

exports.shorthands = undefined;

const GRANTS = [
  { scope: 'qa', key: 'qa.feedback' },
  { scope: 'telecaller_lead', key: 'qa.feedback' },
  { scope: 'head_trainer', key: 'lms.analytics' },
];

exports.up = (pgm) => {
  for (const { scope, key } of GRANTS) {
    pgm.sql(`
      UPDATE custom_roles
         SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                               || jsonb_build_object('${key}', 'full'),
             updated_at = now()
       WHERE deleted_at IS NULL
         AND scope = '${scope}'
         AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? '${key}');
    `);
  }
};

exports.down = (pgm) => {
  for (const { scope, key } of GRANTS) {
    pgm.sql(`
      UPDATE custom_roles
         SET tab_permissions = tab_permissions - '${key}',
             updated_at = now()
       WHERE deleted_at IS NULL AND scope = '${scope}';
    `);
  }
};
