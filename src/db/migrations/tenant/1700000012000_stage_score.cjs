// Add a per-stage / per-sub-stage score weight + a manager_id column on leads
// (to track team-lead alongside the assigned counsellor) so the UI can show
// both names. Lead score recalc lives in the application layer.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE lead_stages      ADD COLUMN IF NOT EXISTS score integer NOT NULL DEFAULT 0;
    ALTER TABLE lead_sub_stages  ADD COLUMN IF NOT EXISTS score integer NOT NULL DEFAULT 0;
    ALTER TABLE leads            ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES users(id) ON DELETE SET NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE lead_stages      DROP COLUMN IF EXISTS score;
    ALTER TABLE lead_sub_stages  DROP COLUMN IF EXISTS score;
    ALTER TABLE leads            DROP COLUMN IF EXISTS manager_id;
  `);
};
