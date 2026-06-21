/* eslint-disable camelcase */
// Multi-branch architecture. A `branch` is a first-class org unit (e.g. a
// city/office), each headed by exactly one branch_manager. Users belong to a
// branch (users.branch_id) and leads carry the owning branch (leads.branch_id,
// snapshotted from the assignee — same pattern as leads.manager_id).
//
// Branch lead visibility is by branch_id: a branch_manager sees every lead in
// their branch (assigned or not), which is cleaner than inferring the branch
// from the manager_id subtree. See leads/service.js computeScope.
//
// One branch_manager per branch is enforced by a partial UNIQUE index on
// branch_manager_id (a manager can head at most one active branch).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE branches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      code text,                                  -- optional short code (e.g. 'MUM')
      branch_manager_id uuid REFERENCES users(id) ON DELETE SET NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    -- A branch name is unique among the live (non-deleted) branches.
    CREATE UNIQUE INDEX branches_name_unique
      ON branches (lower(name)) WHERE deleted_at IS NULL;
    -- A user can head at most one live branch.
    CREATE UNIQUE INDEX branches_one_per_manager
      ON branches (branch_manager_id)
      WHERE deleted_at IS NULL AND branch_manager_id IS NOT NULL;
    CREATE TRIGGER trg_branches_updated_at
      BEFORE UPDATE ON branches
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Which branch a user belongs to. NULL = unassigned to any branch
    -- (e.g. the tenant super_admin, who spans all branches).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id uuid
      REFERENCES branches(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS users_branch_id_idx ON users (branch_id);

    -- The owning branch of a lead, snapshotted from the assignee's branch on
    -- assignment/creation (mirrors leads.manager_id). NULL until the lead is
    -- routed into a branch.
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS branch_id uuid
      REFERENCES branches(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS leads_branch_id_idx ON leads (branch_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE leads DROP COLUMN IF EXISTS branch_id;
    ALTER TABLE users DROP COLUMN IF EXISTS branch_id;
    DROP TABLE IF EXISTS branches;
  `);
};
