/* eslint-disable camelcase */
// Grant the `missed_leads` tab (Missed Leads) to the front line and the
// tiers above it.
//
// Leads that carry a follow-up are exempt from the 6-day/7-day stale-lead
// rotation, INCLUDING ones whose follow-up was missed — a broken promise means
// the OWNER needs chasing, not that the lead should be taken off them. That
// exemption is correct, but on its own it would let those leads go quiet, so
// this tab is the counterweight: it puts every broken commitment in front of
// the person who made it and everyone above them.
//
// Granted to counsellor + telecaller (their own promises), telecaller_lead +
// sales_manager (their team's), and branch_manager + super_admin. No role
// branch is needed on the route itself: GET /follow-ups/missed scopes a lead
// owner to l.assigned_to = self and a manager to teamHierarchyMulti(), the same
// way the rest of the follow-ups module does.
//
// Idempotent, and adds the key only when absent so a per-tenant custom level
// set later by an admin is never overwritten.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb)
                             || jsonb_build_object('missed_leads', 'full'),
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('super_admin', 'branch_manager', 'sales_manager',
                     'telecaller_lead', 'counsellor', 'telecaller')
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'missed_leads');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = tab_permissions - 'missed_leads',
           updated_at = now()
     WHERE deleted_at IS NULL
       AND scope IN ('super_admin', 'branch_manager', 'sales_manager',
                     'telecaller_lead', 'counsellor', 'telecaller');
  `);
};
