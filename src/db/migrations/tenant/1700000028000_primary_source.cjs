// Adds a dictionary table for "primary_source" — a separate marketing
// dimension from `source` (which lives in lead_sources_dict) — plus a FK
// on leads.primary_source_id.
//
// Schema mirrors lead_sources_dict / lead_campaigns_dict / lead_mediums
// (name UNIQUE, is_active, order_index, deleted_at) so the existing
// `autoCreateSingle` resolver helper works unchanged.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE lead_primary_sources (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      is_active boolean NOT NULL DEFAULT true,
      order_index integer NOT NULL DEFAULT 0,
      deleted_at timestamptz
    );

    ALTER TABLE leads
      ADD COLUMN IF NOT EXISTS primary_source_id uuid
        REFERENCES lead_primary_sources(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS leads_primary_source_id_idx
      ON leads (primary_source_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS leads_primary_source_id_idx;
    ALTER TABLE leads DROP COLUMN IF EXISTS primary_source_id;
    DROP TABLE IF EXISTS lead_primary_sources;
  `);
};
