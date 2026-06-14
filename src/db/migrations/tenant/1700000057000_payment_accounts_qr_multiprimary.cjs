// Payment accounts: allow a QR image + MULTIPLE primary accounts.
//
// Two changes:
//   1. qr_r2_key — GCS key of an uploaded QR-code image (e.g. the UPI QR).
//      Available on both bank and UPI accounts. Shown to the student on the
//      public admission form so they can scan-to-pay.
//   2. Multiple primaries — the product rule changes from "exactly one
//      primary" to "AT LEAST one primary". The admin can mark 1+ accounts
//      primary; the app guarantees the live primary count never hits zero.
//      So we DROP the old single-primary unique index. is_primary stays a
//      plain boolean flag.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE payment_accounts
      ADD COLUMN IF NOT EXISTS qr_r2_key text;

    -- Drop the exactly-one-primary guarantee. Multiple primaries are now
    -- allowed; "at least one" is enforced in the app layer (repo) since it's
    -- a cross-row count invariant that a simple constraint can't express.
    DROP INDEX IF EXISTS one_primary_payment_account;
  `);
};

exports.down = async (pgm) => {
  // Re-create the single-primary index. This will FAIL if more than one
  // primary currently exists — demote extras first so the down migration is
  // safe to run.
  await pgm.db.query(`
    UPDATE payment_accounts
       SET is_primary = false
     WHERE deleted_at IS NULL
       AND is_primary = true
       AND id <> (
         SELECT id FROM payment_accounts
          WHERE deleted_at IS NULL AND is_primary = true
          ORDER BY created_at ASC
          LIMIT 1
       );

    CREATE UNIQUE INDEX one_primary_payment_account
      ON payment_accounts ((is_primary))
      WHERE is_primary = true AND deleted_at IS NULL;

    ALTER TABLE payment_accounts
      DROP COLUMN IF EXISTS qr_r2_key;
  `);
};
