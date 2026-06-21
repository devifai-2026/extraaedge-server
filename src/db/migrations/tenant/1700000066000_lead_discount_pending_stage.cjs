/* eslint-disable camelcase */
// Discount-gates-conversion: when a counsellor requests a >10% discount while
// converting a lead, the conversion is HELD until a manager approves. We record
// the stage the lead should move into once approved, so approval can complete
// the held conversion.
//
//   pending_stage_id     — the conversion stage the counsellor was moving to
//   pending_sub_stage_id — the sub-stage (if any) for that move
//
// Both are NULL for discounts that didn't gate a conversion (e.g. a manager
// applying a discount directly, or a <=10% auto-approved discount).
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_discounts
      ADD COLUMN IF NOT EXISTS pending_stage_id uuid REFERENCES lead_stages(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS pending_sub_stage_id uuid REFERENCES lead_sub_stages(id) ON DELETE SET NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_discounts
      DROP COLUMN IF EXISTS pending_stage_id,
      DROP COLUMN IF EXISTS pending_sub_stage_id;
  `);
};
