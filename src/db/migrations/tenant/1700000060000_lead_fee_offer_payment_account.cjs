/* eslint-disable camelcase */
// Bind a payment account to a lead's fee offer.
//
// The accounts team configures the fee plan (course fees, registration,
// installments) per lead, and now also picks WHICH bank/UPI account the
// student should pay into. Storing it on the offer means the choice is made
// once, in the Configure/Reconfigure dialog, and reused every time a public
// share-link is generated for that lead — no per-share re-picking.
//
// Nullable: legacy offers carry no account (the share-link / public form
// then fall back to the tenant's primary accounts). No FK — payment_accounts
// can be soft-deleted; we keep the historical id and resolve it on read.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_fee_offers
      ADD COLUMN IF NOT EXISTS payment_account_id uuid;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_fee_offers
      DROP COLUMN IF EXISTS payment_account_id;
  `);
};
