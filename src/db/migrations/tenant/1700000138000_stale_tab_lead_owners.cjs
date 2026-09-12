/* eslint-disable camelcase */
// Give counsellors and telecallers the Stale Leads tab.
//
// The 6-day/7-day rule takes leads AWAY from the front line, but the tab was
// granted only to super_admin / branch_manager / sales_manager /
// telecaller_lead — so the people who actually lose the leads could not see the
// warning. Showing an owner their own "Coming up" list inside the 6-day window
// is the cheapest way to stop leads going stale at all.
//
// Server-side scoping already does the right thing without a role branch:
// computeScope returns { user_ids: [actor.id] } for a front-line user, so they
// see only their OWN rows on an endpoint the manager tiers already use.
//
// Idempotent; never overwrites a per-tenant custom level.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || jsonb_build_object('stale_handovers', 'full'),
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('counsellor', 'telecaller')
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'stale_handovers');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions - 'stale_handovers',
           updated_at = now()
     WHERE deleted_at IS NULL AND scope IN ('counsellor', 'telecaller');
  `);
};
