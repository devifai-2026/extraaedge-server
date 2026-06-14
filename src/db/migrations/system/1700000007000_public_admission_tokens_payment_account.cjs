// Bind a chosen payment account to a public admission share-link.
//
// When the accounts user generates the student form link, they now pick
// ONE payment account (bank / UPI / QR) the student should pay the
// registration amount into. We persist that choice on the token so the
// public form shows exactly that account — not the full primary list —
// and the student's submitted proof is attributed to it.
//
// Nullable + ON DELETE SET NULL: legacy tokens carry no account (the
// public form then falls back to showing the tenant's primary accounts),
// and deleting a payment account must never orphan a live link.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE public_admission_tokens
      ADD COLUMN IF NOT EXISTS payment_account_id uuid;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE public_admission_tokens
      DROP COLUMN IF EXISTS payment_account_id;
  `);
};
