/* eslint-disable camelcase */

// Interview rounds (L1/L2/...), a panel of invited interviewers, and one
// feedback row per panellist.
//
// WHAT THE OLD SHAPE COULD NOT EXPRESS
//   hiring_interviews had a single interviewer_id and two fixed columns,
//   remark_1 / remark_2. So:
//     - only one person could own an interview;
//     - feedback was anonymous — two remarks with nobody attached, which makes
//       "who said the candidate was weak on SQL" unanswerable;
//     - there was no notion of a round, so an L1 and an L2 for the same
//       candidate were indistinguishable apart from their timestamps.
//
// Three changes, each kept additive so nothing that reads the old columns
// breaks on deploy.

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ---- 1. Rounds -------------------------------------------------------
  //
  // A table, not a CHECK of fixed values, to match hiring_statuses: the
  // tenant already configures its own statuses and positions, so hard-coding
  // L1/L2/L3 here would be the one list in this module an admin cannot edit.
  // Seeded with the common ladder so it works out of the box.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS hiring_rounds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      -- Drives ordering in the UI and "what comes next" on a candidate.
      order_index int NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS hiring_rounds_name_uq ON hiring_rounds (lower(name));
  `);

  pgm.sql(`
    INSERT INTO hiring_rounds (name, order_index) VALUES
      ('L1', 10), ('L2', 20), ('L3', 30), ('HR', 40), ('Final', 50)
    ON CONFLICT DO NOTHING
  `);

  // ---- 2. Interview: round + meeting link ------------------------------
  pgm.addColumns('hiring_interviews', {
    round_id: { type: 'uuid', references: 'hiring_rounds(id)', onDelete: 'SET NULL' },
    meeting_link: { type: 'text' },
  });

  // meeting_link is OPTIONAL by product decision — no DB constraint. An
  // interview may be booked before the Meet/Teams link exists, and an
  // in-person round never needs one; forcing a value would only train people
  // to paste junk to get past the form.

  pgm.sql(`CREATE INDEX IF NOT EXISTS hiring_interviews_round_idx ON hiring_interviews (round_id) WHERE deleted_at IS NULL`);

  // ---- 3. Panel --------------------------------------------------------
  //
  // Who was invited to sit on this interview. interviewer_id stays as the
  // organiser so existing reads keep working; this table is the many side.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS hiring_interview_panel (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      interview_id uuid NOT NULL REFERENCES hiring_interviews(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
      invited_at timestamptz NOT NULL DEFAULT now()
    );
    -- Inviting the same person twice is a no-op, not a second seat.
    CREATE UNIQUE INDEX IF NOT EXISTS hiring_interview_panel_uq
      ON hiring_interview_panel (interview_id, user_id);
    -- "Show me my interviews" is the hot query on this table.
    CREATE INDEX IF NOT EXISTS hiring_interview_panel_user_idx
      ON hiring_interview_panel (user_id);
  `);

  // Backfill: whoever was the interviewer is on the panel.
  pgm.sql(`
    INSERT INTO hiring_interview_panel (interview_id, user_id, invited_by)
    SELECT i.id, i.interviewer_id, i.created_by
      FROM hiring_interviews i
     WHERE i.interviewer_id IS NOT NULL AND i.deleted_at IS NULL
    ON CONFLICT DO NOTHING
  `);

  // ---- 4. Per-panellist feedback ---------------------------------------
  //
  // One row per person per interview, so every remark carries an author.
  // `recommendation` is deliberately separate from the free-text remark: a
  // hiring decision needs something sortable, and "he was fine" is not.
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS hiring_interview_feedback (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      interview_id uuid NOT NULL REFERENCES hiring_interviews(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      remark text,
      recommendation text,
      submitted_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT hiring_interview_feedback_rec_chk
        CHECK (recommendation IS NULL OR recommendation IN ('strong_yes','yes','no','strong_no','on_hold'))
    );
    -- One verdict per person per interview; re-submitting edits their own.
    CREATE UNIQUE INDEX IF NOT EXISTS hiring_interview_feedback_uq
      ON hiring_interview_feedback (interview_id, user_id);
    CREATE INDEX IF NOT EXISTS hiring_interview_feedback_user_idx
      ON hiring_interview_feedback (user_id);
  `);

  // Backfill the two anonymous columns as the organiser's feedback, so no
  // existing remark is lost. remark_1 and remark_2 are KEPT on the interview
  // row (not dropped) — the list UI still reads them, and dropping a column
  // in the same migration that adds its replacement makes a rollback lossy.
  pgm.sql(`
    INSERT INTO hiring_interview_feedback (interview_id, user_id, remark)
    SELECT i.id, i.interviewer_id,
           btrim(concat_ws(E'\\n\\n', nullif(btrim(i.remark_1), ''), nullif(btrim(i.remark_2), '')))
      FROM hiring_interviews i
     WHERE i.interviewer_id IS NOT NULL
       AND i.deleted_at IS NULL
       AND (nullif(btrim(i.remark_1), '') IS NOT NULL OR nullif(btrim(i.remark_2), '') IS NOT NULL)
    ON CONFLICT DO NOTHING
  `);

};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS hiring_interview_feedback`);
  pgm.sql(`DROP TABLE IF EXISTS hiring_interview_panel`);
  pgm.dropColumns('hiring_interviews', ['round_id', 'meeting_link']);
  pgm.sql(`DROP TABLE IF EXISTS hiring_rounds`);
};
