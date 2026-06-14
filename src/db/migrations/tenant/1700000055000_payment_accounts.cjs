// Admin-managed payment destinations for collecting the registration /
// admission amount: bank accounts and UPI IDs. The accounts team shares the
// admission form; once the student fills it, the team records the amount
// against one of these accounts. Exactly one account is the PRIMARY (the
// default the UI pre-selects). If only one account exists it is implicitly
// primary; the app layer guarantees one-and-only-one primary at all times.
//
// `type` discriminates the row:
//   • 'bank' — uses account_holder_name / account_number / ifsc / bank_name /
//              branch (+ optional account_type savings|current)
//   • 'upi'  — uses upi_id (+ optional account_holder_name as the payee name)
// We keep both shapes in one table (sparse columns) so the UI has a single
// "payment accounts" list and `is_primary` spans both kinds.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE payment_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type text NOT NULL CHECK (type IN ('bank', 'upi')),
      label text,                          -- friendly name e.g. "HDFC Current" / "Office UPI"

      -- Bank fields
      account_holder_name text,
      account_number text,
      ifsc text,
      bank_name text,
      branch text,
      account_type text CHECK (account_type IS NULL OR account_type IN ('savings', 'current')),

      -- UPI field
      upi_id text,

      is_primary boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,

      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,

      -- Per-type completeness: a bank row needs the core bank fields; a upi
      -- row needs a upi_id. Enforced so we never store a half-built account.
      CONSTRAINT payment_accounts_shape CHECK (
        (type = 'bank' AND account_number IS NOT NULL AND ifsc IS NOT NULL AND account_holder_name IS NOT NULL)
        OR
        (type = 'upi' AND upi_id IS NOT NULL)
      )
    );

    -- At most ONE primary among live rows. The app promotes a new primary
    -- when the current one is deleted, and auto-marks the first row primary.
    CREATE UNIQUE INDEX one_primary_payment_account
      ON payment_accounts ((is_primary))
      WHERE is_primary = true AND deleted_at IS NULL;

    CREATE INDEX idx_payment_accounts_live
      ON payment_accounts (created_at DESC)
      WHERE deleted_at IS NULL;

    CREATE TRIGGER trg_payment_accounts_updated_at
      BEFORE UPDATE ON payment_accounts
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS payment_accounts;
  `);
};
