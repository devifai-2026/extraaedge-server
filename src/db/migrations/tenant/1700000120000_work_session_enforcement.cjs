/* eslint-disable camelcase */
// Adds what's needed to force clock-in and to tell a real Stop apart from the
// midnight cron forcibly closing a session someone forgot to end.
//
// closed_reason replaces the never-really-used idle_logout boolean with an
// enum that also covers the new auto_midnight case; idle_logout is left in
// place (still readable) but nothing writes it going forward.
//
// work_activity_minutes.source distinguishes "a request happened this
// minute" (api — the old, gameable signal: background polling counts) from
// "the client also reported a real mouse/keyboard pattern" (genuine). The
// upsert-friendly index lets a minute be upgraded api -> genuine without a
// second row.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE work_sessions
      ADD COLUMN IF NOT EXISTS closed_reason text NOT NULL DEFAULT 'manual_stop'
        CHECK (closed_reason IN ('manual_stop', 'auto_midnight', 'backfill_cleanup')),
      ADD COLUMN IF NOT EXISTS auto_closed boolean NOT NULL DEFAULT false;

    ALTER TABLE work_activity_minutes
      ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'api'
        CHECK (source IN ('api', 'genuine'));

    CREATE INDEX IF NOT EXISTS work_sessions_auto_closed_idx
      ON work_sessions (user_id, auto_closed) WHERE auto_closed;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP INDEX IF EXISTS work_sessions_auto_closed_idx;
    ALTER TABLE work_sessions
      DROP COLUMN IF EXISTS closed_reason,
      DROP COLUMN IF EXISTS auto_closed;
    ALTER TABLE work_activity_minutes
      DROP COLUMN IF EXISTS source;
  `);
};
