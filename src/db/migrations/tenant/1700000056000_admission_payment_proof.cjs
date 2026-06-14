// Registration-amount payment proof on the admission.
//
// New flow: the public admission form shows the tenant's PRIMARY payment
// account (bank/UPI) so the student pays the registration amount, then the
// student MUST upload a payment screenshot + enter the UTR/reference number
// before they can submit. The payment is recorded as UNVERIFIED; the accounts
// team confirms it against their bank statement (manual verification — no tech
// can guarantee a screenshot is a genuine payment).
//
// Columns:
//   payment_proof_r2_key  — GCS key of the uploaded screenshot (signed-URL'd)
//   payment_utr           — UTR / UPI reference / txn id the student entered
//   payment_account_id    — which payment_accounts row they were asked to pay
//   payment_amount        — amount snapshot (the offer's registration_amount)
//   payment_verified_at   — set when accounts confirms the payment
//   payment_verified_by   — which user confirmed it
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE admissions
      ADD COLUMN IF NOT EXISTS payment_proof_r2_key text,
      ADD COLUMN IF NOT EXISTS payment_utr          text,
      ADD COLUMN IF NOT EXISTS payment_account_id   uuid REFERENCES payment_accounts(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS payment_amount       numeric(12,2),
      ADD COLUMN IF NOT EXISTS payment_verified_at  timestamptz,
      ADD COLUMN IF NOT EXISTS payment_verified_by  uuid REFERENCES users(id) ON DELETE SET NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE admissions
      DROP COLUMN IF EXISTS payment_verified_by,
      DROP COLUMN IF EXISTS payment_verified_at,
      DROP COLUMN IF EXISTS payment_amount,
      DROP COLUMN IF EXISTS payment_account_id,
      DROP COLUMN IF EXISTS payment_utr,
      DROP COLUMN IF EXISTS payment_proof_r2_key;
  `);
};
