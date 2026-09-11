/* eslint-disable camelcase */
// Record WHY a stale-lead escalation did not hand the lead over.
//
// Before this, a failed handover was invisible: the scanner stamped
// escalated_at, tried to pick a replacement, and if the pick returned null it
// simply moved on. The alert then looked identical to a successful escalation
// minus the lead_assignments row, so the only available explanation was the
// guess "nobody was free" — which was wrong in practice. On SpeedUp 1,504
// leads sat in that state while three eligible counsellors were active.
//
// Two columns:
//   hold_reason  — a short machine code (see HOLD_REASONS in
//                  workers/sla-scanner.js) explaining the null pick.
//   handover_attempts — how many times the scanner has tried. Lets a stranded
//                  alert be retried on a later tick instead of being frozen
//                  forever by escalated_at being set once (the retry query
//                  keys off this), and shows an admin that the system is
//                  still trying rather than having given up.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE sla_alerts
      ADD COLUMN IF NOT EXISTS hold_reason text,
      ADD COLUMN IF NOT EXISTS handover_attempts integer NOT NULL DEFAULT 0;
  `);
  // Alerts that escalated but never produced an SLA handover are the existing
  // backlog. Mark them so the UI can say "will retry" instead of inventing a
  // reason, and so the scanner's retry pass picks them up.
  pgm.sql(`
    UPDATE sla_alerts a
       SET hold_reason = 'unknown_legacy', handover_attempts = 1
     WHERE a.escalated_at IS NOT NULL
       AND a.hold_reason IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM lead_assignments la
          WHERE la.lead_id = a.lead_id
            AND la.from_user_id = a.assigned_to
            AND la.reason ILIKE 'SLA:%'
            AND la.created_at >= a.escalated_at - interval '1 minute'
       );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE sla_alerts
      DROP COLUMN IF EXISTS hold_reason,
      DROP COLUMN IF EXISTS handover_attempts;
  `);
};
