// `is_success` marks a stage as a "converted" outcome. When a lead enters such
// a stage we stamp leads.converted_at = now(); when it leaves, we clear it.
// This is what the dashboard's "Converted" / "Lead-to-Enrolled %" reports off.
//
// Backfill: any existing terminal stage that *isn't* clearly a fail bucket
// (Junk / Cold) gets `is_success = true` so the demo tenant's "Enrolled"
// stage works out of the box. Admins can flip the flag in the Stage edit
// dialog afterwards.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE lead_stages ADD COLUMN IF NOT EXISTS is_success boolean NOT NULL DEFAULT false;

    UPDATE lead_stages
       SET is_success = true
     WHERE is_terminal = true
       AND lower(name) NOT IN ('junk', 'cold', 'lost', 'dropped', 'duplicate');
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`ALTER TABLE lead_stages DROP COLUMN IF EXISTS is_success;`);
};
