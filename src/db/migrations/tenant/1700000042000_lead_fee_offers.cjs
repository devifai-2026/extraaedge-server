/* eslint-disable camelcase */
// Per-lead "fee offer" — the accounts team's customised offer for a
// specific converted lead. Read by the public admission form (student
// sees it as read-only) and used to gate the share-link generator.
//
// Why a separate table (and not extra columns on `leads` or `admissions`):
//   • Fees on the program row are the catalog defaults; one row per
//     program. We need a per-lead override that does NOT mutate the
//     program. So this can't live on programs.
//   • It must exist BEFORE the admission is created (the student fills
//     the admission form, then we approve). So it can't live on
//     admissions either — admission rows for the same lead come and go.
//   • Keeping it as its own table also means a manager can reconfigure
//     the offer multiple times before the student submits, with a clear
//     update path (one row per lead) and no risk of accidentally
//     overwriting the program-level defaults.
//
// One row per lead. fee_installments is jsonb (same shape as the program
// column) — max 4 entries enforced by the service-layer zod refine.
//
// The math constraint (registration + Σ installments = course_fees when
// payment_mode='installment') is enforced in service.js, not as a DB
// CHECK, because checking jsonb sums in Postgres is awkward and we need
// a clean field-level error message back to the FE form.

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS lead_fee_offers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
      program_id uuid REFERENCES programs(id) ON DELETE SET NULL,
      course_fees numeric(12,2) NOT NULL,
      registration_amount numeric(12,2) NOT NULL DEFAULT 0,
      payment_mode text NOT NULL CHECK (payment_mode IN ('full', 'installment')),
      fee_installments jsonb,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_lead_fee_offers_program ON lead_fee_offers (program_id);

    -- Standard updated_at trigger (matches sibling tables).
    DROP TRIGGER IF EXISTS trg_lead_fee_offers_updated_at ON lead_fee_offers;
    CREATE TRIGGER trg_lead_fee_offers_updated_at
      BEFORE UPDATE ON lead_fee_offers
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS lead_fee_offers;`);
};
