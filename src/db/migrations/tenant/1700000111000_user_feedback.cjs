// Forceful in-app feedback popup (5-star + comment).
//
// Every tenant user is shown a feedback popup until they submit it once. They
// may close it, but it re-appears 5 minutes later (tracked server-side via
// dismissed_at so it persists across logins). After submitting once, the popup
// never returns for that user (submitted_at is set).
//
//   user_feedback_state  one row per user: their popup lifecycle
//                        (submitted_at, last_dismissed_at). Drives whether the
//                        FE shows the popup and when to re-show it.
//   user_feedback        the actual response (rating 1-5 + comment). One row
//                        per user (unique), so PO sees exactly one per person.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE user_feedback_state (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      submitted_at timestamptz,                 -- set once they submit → popup stops forever
      last_dismissed_at timestamptz,            -- last "close" → re-show 5 min after this
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE user_feedback (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      rating smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
      comment text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX user_feedback_created_at_idx ON user_feedback (created_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS user_feedback;
    DROP TABLE IF EXISTS user_feedback_state;
  `);
};
