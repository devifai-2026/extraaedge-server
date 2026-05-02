// Many-to-many "reports to" join: a counsellor can report to multiple managers,
// a manager can report to multiple admins. We keep `users.manager_id` as the
// "primary" reporting line for backwards compat (auto-assignment, lead scope),
// and add a join table for the secondary reports.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS designation text;

    CREATE TABLE IF NOT EXISTS user_managers (
      user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      manager_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, manager_id),
      CHECK (user_id <> manager_id)
    );
    CREATE INDEX IF NOT EXISTS user_managers_user_idx    ON user_managers(user_id);
    CREATE INDEX IF NOT EXISTS user_managers_manager_idx ON user_managers(manager_id);

    -- Backfill from the existing single manager_id so we don't lose history.
    INSERT INTO user_managers (user_id, manager_id)
      SELECT id, manager_id FROM users
       WHERE manager_id IS NOT NULL AND deleted_at IS NULL
    ON CONFLICT DO NOTHING;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS user_managers;`);
};
