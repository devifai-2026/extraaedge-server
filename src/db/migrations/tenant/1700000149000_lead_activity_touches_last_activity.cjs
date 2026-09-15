/* eslint-disable camelcase */
// Human activity on a lead must count as activity for the 6-day stale-lead
// auto-rotation.
//
// THE BUG THIS FIXES (the "Pavan Honmale" case on the SpeedUp tenant):
// workers/sla-scanner.js decides staleness purely on `leads.last_activity_at`.
// But almost nothing was maintaining that column. Completing a follow-up,
// rescheduling one, cancelling one, adding a note/comment, or logging a call
// all wrote a `lead_activities` row and nothing else — so the counsellor saw
// their work on the timeline while the scanner kept ageing the lead. On day 6
// it was flagged and on day 7 auto-reassigned to another counsellor, despite
// a follow-up having been completed days earlier.
//
// The same blind spot defeated the scanner's own safety net: it auto-resolves
// an alert when `l.last_activity_at > a.flagged_at`, which could never become
// true for these actions.
//
// WHY A TRIGGER RATHER THAN PATCHING THE ROUTES:
// 21 files insert into lead_activities. Patching each one leaves the next
// feature free to reintroduce the bug. `lead_activities` is already the single
// chokepoint every touch funnels through, so maintaining last_activity_at here
// makes "activity" mean one thing across the whole codebase, including code
// not yet written.
//
// WHY user_id IS NOT NULL IS THE TEST:
// System-generated rows are written with user_id = NULL — the SLA scanner's own
// 'auto_assign', the missed-followup scanner's 'follow_up_missed', the reminder
// scheduler's 'followup_overdue'. Those must NOT count:
//   • 'follow_up_missed' / 'followup_overdue' fire precisely BECAUSE nobody
//     acted. Treating them as activity would make a neglected lead look tended
//     and permanently immunise it from the rotation — the exact opposite of
//     what the policy is for.
//   • 'auto_assign' is the rotation's own handover. Counting it would restart
//     the clock from the machine's action rather than the new owner's first
//     real touch.
// Human actions always carry req.user.id, so this cleanly separates "a person
// worked this lead" from "the system observed something about it".
//
// GREATER(): last_activity_at must never move BACKWARDS. Back-dated or
// back-filled activity rows would otherwise drag a freshly-touched lead's
// timestamp into the past and make it look stale.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE OR REPLACE FUNCTION lead_activity_touches_lead()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.user_id IS NOT NULL THEN
        UPDATE leads
           SET last_activity_at = GREATEST(last_activity_at, NEW.created_at)
         WHERE id = NEW.lead_id;
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  await pgm.db.query(`DROP TRIGGER IF EXISTS trg_lead_activity_touches_lead ON lead_activities;`);
  await pgm.db.query(`
    CREATE TRIGGER trg_lead_activity_touches_lead
      AFTER INSERT ON lead_activities
      FOR EACH ROW EXECUTE FUNCTION lead_activity_touches_lead();
  `);

  // ---- Repair the leads this bug already mis-aged -----------------------
  // Pull last_activity_at up to each lead's most recent HUMAN activity. Same
  // user_id IS NOT NULL rule as the trigger, and GREATEST so nothing moves
  // backwards. Without this, leads that were quietly worked (but never had the
  // column bumped) stay in the day-6/day-7 firing line on the very next tick.
  await pgm.db.query(`
    UPDATE leads l
       SET last_activity_at = GREATEST(l.last_activity_at, a.last_human)
      FROM (
        SELECT lead_id, MAX(created_at) AS last_human
          FROM lead_activities
         WHERE user_id IS NOT NULL
         GROUP BY lead_id
      ) a
     WHERE a.lead_id = l.id
       AND a.last_human > l.last_activity_at
  `);

  // Resolve alerts that are now provably wrong: a human had touched the lead
  // at or after the alert was raised, so the breach never really existed.
  // Leaves genuinely stale alerts untouched.
  await pgm.db.query(`
    UPDATE sla_alerts s
       SET resolved_at = now(), resolution_reason = 'activity_logged'
      FROM leads l
     WHERE s.lead_id = l.id
       AND s.resolved_at IS NULL
       AND l.last_activity_at > s.flagged_at
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TRIGGER IF EXISTS trg_lead_activity_touches_lead ON lead_activities;`);
  await pgm.db.query(`DROP FUNCTION IF EXISTS lead_activity_touches_lead();`);
};
