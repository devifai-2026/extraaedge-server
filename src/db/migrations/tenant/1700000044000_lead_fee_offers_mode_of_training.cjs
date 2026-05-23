/* eslint-disable camelcase */
// Add `mode_of_training` to lead_fee_offers.
//
// Accounts team picks Online / Offline / Hybrid in the Configure Fee
// Offer modal; the public admission form pre-fills it and shows it as
// read-only to the student. The admissions table already has its own
// mode_of_training column (the student copy is what gets persisted on
// submit); this one captures the manager's intent so a re-issued link
// keeps the correct training mode without re-asking.
//
// Nullable so existing offers remain valid until the manager re-saves.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_fee_offers
      ADD COLUMN IF NOT EXISTS mode_of_training text
        CHECK (mode_of_training IS NULL OR mode_of_training IN ('Online', 'Offline', 'Hybrid'));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_fee_offers DROP COLUMN IF EXISTS mode_of_training;
  `);
};
