/* eslint-disable camelcase */
// Multi-branch membership for teaching staff: a trainer/head_trainer keeps a
// primary users.branch_id but can additionally work across several branches.
// A branch switcher lets them scope their student views to one active branch.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE user_branches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      branch_id uuid NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX user_branches_uq ON user_branches (user_id, branch_id);
    CREATE INDEX user_branches_user_idx ON user_branches (user_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS user_branches;`);
};
