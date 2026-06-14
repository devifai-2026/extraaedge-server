// Unify payment_accounts: ONE account row now carries Bank + UPI + QR
// together (previously `type` made a row exclusively bank OR upi). Admin
// fills any one section fully to save; the app enforces "≥1 complete
// section" (bank = holder+acct+ifsc, or upi_id, or qr_r2_key).
//
// Changes:
//   • Drop the per-type completeness CHECK (payment_accounts_shape) — fields
//     are now independent across sections.
//   • Make `type` nullable (kept for backward-compat / legacy rows; new rows
//     leave it NULL since a row is no longer a single type).
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE payment_accounts DROP CONSTRAINT IF EXISTS payment_accounts_shape;
    ALTER TABLE payment_accounts ALTER COLUMN type DROP NOT NULL;
    ALTER TABLE payment_accounts DROP CONSTRAINT IF EXISTS payment_accounts_type_check;

    -- Tenant-scoped uniqueness (each tenant = its own DB) for account number
    -- and UPI ID, across all LIVE payment accounts. Partial unique indexes so
    -- soft-deleted rows don't block reuse and NULLs (empty sections) are
    -- ignored. The app pre-checks for a friendly 409; these are the backstop.
    CREATE UNIQUE INDEX IF NOT EXISTS payment_accounts_account_number_uq
      ON payment_accounts (account_number)
      WHERE account_number IS NOT NULL AND deleted_at IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS payment_accounts_upi_id_uq
      ON payment_accounts (lower(upi_id))
      WHERE upi_id IS NOT NULL AND deleted_at IS NULL;
  `);
};

exports.down = async (pgm) => {
  // Best-effort restore. Backfill a type for rows that have only one kind of
  // data so the re-added NOT NULL + CHECK don't fail; ambiguous rows default
  // to 'bank'. (Down migrations on relaxed constraints are inherently lossy.)
  await pgm.db.query(`
    UPDATE payment_accounts
       SET type = CASE
         WHEN account_number IS NOT NULL THEN 'bank'
         WHEN upi_id IS NOT NULL THEN 'upi'
         ELSE 'bank'
       END
     WHERE type IS NULL;

    DROP INDEX IF EXISTS payment_accounts_account_number_uq;
    DROP INDEX IF EXISTS payment_accounts_upi_id_uq;

    ALTER TABLE payment_accounts ALTER COLUMN type SET NOT NULL;
    ALTER TABLE payment_accounts
      ADD CONSTRAINT payment_accounts_type_check CHECK (type IN ('bank', 'upi'));
    ALTER TABLE payment_accounts
      ADD CONSTRAINT payment_accounts_shape CHECK (
        (type = 'bank' AND account_number IS NOT NULL AND ifsc IS NOT NULL AND account_holder_name IS NOT NULL)
        OR (type = 'upi' AND upi_id IS NOT NULL)
      );
  `);
};
