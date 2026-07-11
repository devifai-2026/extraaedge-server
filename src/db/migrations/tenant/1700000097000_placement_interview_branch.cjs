/* eslint-disable camelcase */
// Phase F3 — branch correctness. Placement companies + openings and mock
// interviews gain a nullable branch_id so a multi-branch institute can own
// branch-specific hiring partners, openings, and interview panels. NULL means
// "tenant-wide / legacy" (all existing rows), so nothing breaks; branch-bound
// placement/HR users are scoped to their branch, and super_admin still sees all.
// Applications inherit their branch from the opening (no column needed).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE companies      ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;
    ALTER TABLE job_openings   ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;
    ALTER TABLE mock_interviews ADD COLUMN IF NOT EXISTS branch_id uuid REFERENCES branches(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_companies_branch ON companies (branch_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_job_openings_branch ON job_openings (branch_id) WHERE deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_mock_interviews_branch ON mock_interviews (branch_id) WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS idx_companies_branch;
    DROP INDEX IF EXISTS idx_job_openings_branch;
    DROP INDEX IF EXISTS idx_mock_interviews_branch;
    ALTER TABLE companies       DROP COLUMN IF EXISTS branch_id;
    ALTER TABLE job_openings    DROP COLUMN IF EXISTS branch_id;
    ALTER TABLE mock_interviews DROP COLUMN IF EXISTS branch_id;
  `);
};
