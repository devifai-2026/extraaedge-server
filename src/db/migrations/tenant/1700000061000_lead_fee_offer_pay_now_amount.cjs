/* eslint-disable camelcase */
// Explicit "amount to pay now" the accounts team sets on a lead's offer.
//
// Previously the student's upfront payment was pinned to the registration
// amount. The accounts team now wants to state a specific amount the student
// must pay right now into the chosen account (e.g. a partial booking amount
// that differs from the full registration). This is shown on the public form
// as "Amount to pay now" and recorded as the admission's payment_amount.
//
// Nullable: when unset, the public form / submit fall back to the
// registration amount (the prior behaviour), so legacy offers keep working.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_fee_offers
      ADD COLUMN IF NOT EXISTS pay_now_amount numeric(12, 2);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_fee_offers
      DROP COLUMN IF EXISTS pay_now_amount;
  `);
};
