/* eslint-disable camelcase */

// Backfill leads.branch_id from the assignee's branch.
//
// WHY: migration 1700000065000 added leads.branch_id as "NULL until the lead
// is routed into a branch" and never backfilled it. Every lead that existed
// before branches were introduced therefore has branch_id = NULL, while the
// users DO have a branch. A branch manager's analytics dashboard scopes leads
// with `l.branch_id = $1`, so on a tenant with historical data it matched
// nothing: total leads 0, every channel breakdown 0, the funnel and timeline
// empty — on the same page where admissions counts (a different code path)
// showed real numbers. That inconsistency is what this fixes.
//
// The rule mirrors what the application already does when it routes a lead:
// a lead's branch is its assignee's branch (leads/service.js snapshots it on
// assignment). We apply the same rule retroactively.
//
// Deliberately conservative:
//   • Only fills rows where branch_id IS NULL — never overwrites a lead that
//     has already been routed.
//   • Only uses the assignee's branch. An UNASSIGNED lead keeps branch_id
//     NULL, because there is nothing to infer it from; guessing would put
//     leads in a branch that never worked them.
//   • No-ops on tenants that have no branches at all.

exports.up = (pgm) => {
  pgm.sql(`
    UPDATE leads l
       SET branch_id = u.branch_id
      FROM users u
     WHERE l.assigned_to = u.id
       AND l.branch_id IS NULL
       AND u.branch_id IS NOT NULL;
  `);
};

// Not reversible in a meaningful way: we cannot tell a backfilled branch_id
// apart from one the app set during normal routing, and blanking every
// lead's branch would be far more destructive than leaving the data in place.
exports.down = () => {};
