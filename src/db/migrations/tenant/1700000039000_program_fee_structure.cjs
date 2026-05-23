/* eslint-disable camelcase */
// Optional fee-structure fields on the program (course) row.
//
// Why: org admins want to declare the canonical fee breakup on the
// program itself — total course fees, registration component, and (if
// installment) the per-EMI amounts — so the admission form / public
// link can pre-fill them instead of asking each student to type a fee.
//
// Storage choice — fee_installments as jsonb instead of a child table:
//   • Max 4 rows. The row is meaningless without the full set.
//   • No cross-row queries needed; we always read/write the whole array.
//   • Keeps the migration + repo simple.
// Shape: [{ installment_no: 1..4, amount: number }, ...]
//
// The math constraint (registration_amount + Σ fee_installments.amount
// must equal course_fees) is enforced in the service-layer zod refine
// — checking jsonb sums in a Postgres CHECK is awkward and we want a
// readable error message back to the admin form anyway.
//
// All four columns are nullable. Existing rows stay empty, per spec.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE programs
      ADD COLUMN IF NOT EXISTS course_fees         numeric(12,2),
      ADD COLUMN IF NOT EXISTS registration_amount numeric(12,2),
      ADD COLUMN IF NOT EXISTS payment_mode        text
        CHECK (payment_mode IS NULL OR payment_mode IN ('full', 'installment')),
      ADD COLUMN IF NOT EXISTS fee_installments    jsonb;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE programs
      DROP COLUMN IF EXISTS fee_installments,
      DROP COLUMN IF EXISTS payment_mode,
      DROP COLUMN IF EXISTS registration_amount,
      DROP COLUMN IF EXISTS course_fees;
  `);
};
