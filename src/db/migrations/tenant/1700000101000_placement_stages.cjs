/* eslint-disable camelcase */
// Phase G6 — dynamic placement pipeline. The placement team defines their OWN
// ordered candidate stages (no seed) — e.g. Resume Shortlisted → L1 → L2 →
// Joined — each with a kind: in_progress | success (joined/placed) | rejected
// (a rejected-kind move requires a reason: candidate dropped / client dropped /
// rejected). Every stage move on an application is recorded with a timestamp in
// application_stage_history, so the candidate's journey is auditable. The legacy
// job_applications.status free-text column stays for back-compat.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS placement_stages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      kind text NOT NULL DEFAULT 'in_progress',    -- 'in_progress' | 'success' | 'rejected'
      order_index integer NOT NULL DEFAULT 0,
      branch_id uuid REFERENCES branches(id) ON DELETE SET NULL,  -- NULL = all branches
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS placement_stages_order_idx ON placement_stages (order_index);
    CREATE TRIGGER trg_placement_stages_updated_at BEFORE UPDATE ON placement_stages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Current stage pointer on the application (coexists with legacy status).
    ALTER TABLE job_applications ADD COLUMN IF NOT EXISTS stage_id uuid REFERENCES placement_stages(id) ON DELETE SET NULL;

    -- Timestamped trail of every stage move (with the reason on a reject/drop).
    CREATE TABLE IF NOT EXISTS application_stage_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      application_id uuid NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,
      stage_id uuid REFERENCES placement_stages(id) ON DELETE SET NULL,
      stage_name text,           -- denormalized so history survives a stage rename/delete
      stage_kind text,
      reason text,               -- required when moving to a 'rejected'-kind stage
      moved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS application_stage_history_app_idx ON application_stage_history (application_id, created_at);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS application_stage_history;
    ALTER TABLE job_applications DROP COLUMN IF EXISTS stage_id;
    DROP TABLE IF EXISTS placement_stages;
  `);
};
