/* eslint-disable camelcase */
// Stale-lead auto-reassignment.
//
// Business rule: if a counsellor or telecaller logs no activity on a lead for
// SIX days, then
//   day 6 — the current owner AND their sales manager / telecaller lead /
//           branch manager / super admin are all notified;
//   day 7 — the lead is auto-reassigned to a different owner in the SAME role
//           class (counsellor -> counsellor, telecaller -> telecaller).
//
// This maps onto the existing sla_policies machinery rather than a new table:
//   no_activity_hours    = 144  (6 days)  -> flag + notify the whole chain
//   escalate_after_hours = 24   (day 7)   -> escalate
//   action_json          = [{ type: 'reassign_same_role' }]
//                                         -> escalation performs the handover
//
// workers/sla-scanner.js already auto-resolves an alert the moment
// leads.last_activity_at moves past flagged_at, so an owner who picks the lead
// up on day 6 keeps it and nothing is reassigned.
//
// NOTE: sla_policies was empty in every tenant before this — the scanner
// iterates policies, so it has been inert until now. Seeding this row is what
// switches the feature on.
//
// Idempotent: guarded on the policy name so a re-run won't duplicate it, and
// so an admin who has since retuned the hours/actions via the SLA API keeps
// their settings.

exports.shorthands = undefined;

const POLICY_NAME = 'Stale lead — 6 days no activity';

exports.up = async (pgm) => {
  await pgm.db.query(
    `INSERT INTO sla_policies
       (name, condition_json, no_activity_hours, escalate_after_hours, action_json, is_active)
     SELECT $1,
            -- Extra guards beyond the scanner's own SQL (which already skips
            -- unassigned and converted leads): leave leads explicitly parked
            -- as cold out of the rotation.
            '{"all":[{"field":"lead.is_cold","op":"neq","value":true}]}'::jsonb,
            144,
            24,
            '[{"type":"reassign_same_role"}]'::jsonb,
            true
      WHERE NOT EXISTS (
        SELECT 1 FROM sla_policies WHERE name = $1 AND deleted_at IS NULL
      )`,
    [POLICY_NAME],
  );
};

exports.down = async (pgm) => {
  // Soft delete, matching the SLA API's own DELETE — sla_alerts rows reference
  // the policy and are the audit trail of who let leads go stale.
  await pgm.db.query(
    `UPDATE sla_policies SET deleted_at = now(), is_active = false WHERE name = $1`,
    [POLICY_NAME],
  );
};
