/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE work_sessions ALTER COLUMN ended_at DROP NOT NULL;
    ALTER TABLE work_sessions ALTER COLUMN active_minutes SET DEFAULT 0;
    ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'stopped';
    ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS paused_seconds integer NOT NULL DEFAULT 0;
    ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS last_paused_at timestamptz;
    ALTER TABLE work_sessions ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;
    CREATE UNIQUE INDEX IF NOT EXISTS work_sessions_one_open_per_user
      ON work_sessions (user_id) WHERE status IN ('active','paused');
    CREATE INDEX IF NOT EXISTS work_sessions_user_started_idx
      ON work_sessions (user_id, started_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS work_sessions_user_started_idx;
    DROP INDEX IF EXISTS work_sessions_one_open_per_user;
    ALTER TABLE work_sessions DROP COLUMN IF EXISTS last_heartbeat_at;
    ALTER TABLE work_sessions DROP COLUMN IF EXISTS last_paused_at;
    ALTER TABLE work_sessions DROP COLUMN IF EXISTS paused_seconds;
    ALTER TABLE work_sessions DROP COLUMN IF EXISTS status;
  `);
};
