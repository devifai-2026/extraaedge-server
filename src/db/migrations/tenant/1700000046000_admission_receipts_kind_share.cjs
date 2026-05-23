/* eslint-disable camelcase */
// Extend admission_receipts with:
//   • receipt_kind     — what this receipt is for. One of:
//       'installment'  → paying a specific installment slot (uses installment_no)
//       'registration' → the one-time registration amount (at most 1 per admission)
//       'misc'         → legacy / catch-all (default for existing rows)
//   • installment_no   — only set when receipt_kind = 'installment'.
//   • share_token      — 32-byte random token for public receipt URLs. Each
//                        receipt gets one at create time; the public route
//                        `/r/:token` resolves it. Nullable so old rows
//                        don't fail the partial unique index.
//
// All additions are nullable / default-friendly so the migration is
// online-safe. Backfilling existing rows is a tenant-by-tenant decision
// (defaults to 'misc') and can be done later without locking writes.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE admission_receipts
      ADD COLUMN IF NOT EXISTS receipt_kind text NOT NULL DEFAULT 'misc'
        CHECK (receipt_kind IN ('installment', 'registration', 'misc')),
      ADD COLUMN IF NOT EXISTS installment_no smallint,
      ADD COLUMN IF NOT EXISTS share_token text;

    -- Enforce: at most one 'registration' receipt per admission (active).
    -- Partial unique index keeps it cheap and ignores soft-deleted rows.
    CREATE UNIQUE INDEX IF NOT EXISTS admission_receipts_one_registration_uq
      ON admission_receipts (admission_id)
      WHERE deleted_at IS NULL AND receipt_kind = 'registration';

    -- Enforce: at most one active receipt per (admission, installment_no)
    -- so accounts can't double-log the same EMI.
    CREATE UNIQUE INDEX IF NOT EXISTS admission_receipts_one_per_slot_uq
      ON admission_receipts (admission_id, installment_no)
      WHERE deleted_at IS NULL AND receipt_kind = 'installment';

    -- share_token must be globally unique (it's the public URL key). Partial
    -- index ignores NULL tokens (legacy rows + soft-deleted rows).
    CREATE UNIQUE INDEX IF NOT EXISTS admission_receipts_share_token_uq
      ON admission_receipts (share_token)
      WHERE share_token IS NOT NULL AND deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS admission_receipts_one_registration_uq;
    DROP INDEX IF EXISTS admission_receipts_one_per_slot_uq;
    DROP INDEX IF EXISTS admission_receipts_share_token_uq;
    ALTER TABLE admission_receipts
      DROP COLUMN IF EXISTS receipt_kind,
      DROP COLUMN IF EXISTS installment_no,
      DROP COLUMN IF EXISTS share_token;
  `);
};
