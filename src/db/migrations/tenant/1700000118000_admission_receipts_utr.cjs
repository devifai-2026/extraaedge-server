/* eslint-disable camelcase */
// Give admission_receipts a real UTR / bank-reference column.
//
// Until now the only place a transaction reference could go was
// `transaction_details`, which is a free-text notes field — the approve()
// path writes prose into it ("UTR 123456789012"), and accounts users type
// whatever context they want. That makes it impossible to constrain.
//
// A UTR identifies exactly one real bank transaction, so two receipts
// claiming the same one is always an error: either the same payment was
// recorded twice, or someone dragged a cell down a spreadsheet column. The
// historical-admission importer accepts UTRs per payment, so we need the
// database to be the backstop rather than trusting one importer's in-memory
// check.
//
// Hence a dedicated nullable column with a partial unique index. Nullable
// because most collections are cash and have no UTR at all; partial on
// deleted_at so voiding a receipt frees its UTR for re-entry.
//
// transaction_details is left exactly as it is — it stays the free-text
// notes field, and nothing that writes it today needs to change.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE admission_receipts
      ADD COLUMN IF NOT EXISTS utr text;

    CREATE UNIQUE INDEX IF NOT EXISTS admission_receipts_utr_uq
      ON admission_receipts (upper(utr))
      WHERE utr IS NOT NULL AND deleted_at IS NULL;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP INDEX IF EXISTS admission_receipts_utr_uq;
    ALTER TABLE admission_receipts DROP COLUMN IF EXISTS utr;
  `);
};
