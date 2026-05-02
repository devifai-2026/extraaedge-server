// Per-event login / logout audit. We can derive:
//   - logins-per-day per user
//   - last login / last logout timestamps
//   - distinct active days
// from a single append-only table.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS user_login_events (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind        text NOT NULL CHECK (kind IN ('login', 'logout', 'expired')),
      session_id  uuid,
      ip          text,
      user_agent  text,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS user_login_events_user_idx ON user_login_events(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS user_login_events_kind_idx ON user_login_events(kind, created_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS user_login_events;`);
};
