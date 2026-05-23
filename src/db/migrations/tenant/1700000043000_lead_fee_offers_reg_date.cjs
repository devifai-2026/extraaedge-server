/* eslint-disable camelcase */
// Add `registration_date` to lead_fee_offers.
//
// The accounts team enters the registration amount + the date that
// amount was (or will be) paid; the student form mirrors the admin
// layout from the spec image with both fields side by side.
//
// Nullable on existing rows so the column add is online-safe.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_fee_offers
      ADD COLUMN IF NOT EXISTS registration_date date;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_fee_offers DROP COLUMN IF EXISTS registration_date;
  `);
};
