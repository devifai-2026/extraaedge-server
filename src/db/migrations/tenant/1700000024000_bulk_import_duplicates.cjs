// Captures rows from a bulk lead import that matched an existing lead
// (by email / phone / whatsapp_number). These do NOT go in
// bulk_import_failures because that table is for invalid data; duplicates
// are valid data that already exists, which is a different problem the
// /failedleads UI lists separately.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE bulk_import_duplicates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      import_id uuid NOT NULL REFERENCES bulk_imports(id) ON DELETE CASCADE,
      row_number integer NOT NULL,
      raw_row_json jsonb NOT NULL,
      matched_lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
      match_field text NOT NULL CHECK (match_field IN ('email', 'phone', 'whatsapp_number')),
      match_value text NOT NULL,
      resolution text NOT NULL DEFAULT 'pending'
        CHECK (resolution IN ('pending', 'skipped', 'merged', 'created_anyway')),
      resolved_at timestamptz,
      resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON bulk_import_duplicates (import_id);
    CREATE INDEX ON bulk_import_duplicates (matched_lead_id);
    CREATE INDEX ON bulk_import_duplicates (resolution) WHERE resolution = 'pending';
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS bulk_import_duplicates;`);
};
