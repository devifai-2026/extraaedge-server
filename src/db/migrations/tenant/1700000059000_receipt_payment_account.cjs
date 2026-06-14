/* eslint-disable camelcase */
// Which payment account each receipt was collected into.
//
// Until now we only knew the account tied to the whole admission
// (admissions.payment_account_id, set from the student's registration
// payment proof). But the accounts team records many receipts per
// admission — registration, each installment, misc — and those can land
// in DIFFERENT accounts (e.g. registration via UPI, an installment via
// bank transfer). Recording the account PER RECEIPT lets the Payments
// ledger attribute every rupee to the exact destination it hit.
//
// Nullable: legacy receipts + cash collections may carry no account.
// No FK — payment_accounts can be soft-deleted; we keep the historical
// id even if the account row is later removed (the ledger LEFT JOINs).

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE admission_receipts
      ADD COLUMN IF NOT EXISTS payment_account_id uuid;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE admission_receipts
      DROP COLUMN IF EXISTS payment_account_id;
  `);
};
