/* eslint-disable camelcase */
// Per-tenant fee-receipt configuration.
//
// The student-facing fee receipt (/r/:token) now renders a fixed "FEE RECEIPT"
// layout whose footer wording and receipt-number format vary per organisation.
// These live on the system-DB tenants row (same home as branding) because the
// public receipt is resolved tenant-agnostically and reads the tenant row
// directly — the per-tenant DB never sees this config.
//
// Numbering: when receipt_no_prefix is set, new receipts get
//   `<prefix>-<zero-padded counter>` (e.g. 2026-01024), the counter coming from
//   a per-tenant-DB receipt_counters row seeded from receipt_no_start. When the
//   prefix is null the app falls back to the legacy RC-YYYYMMDD-NNNN scheme, so
//   existing tenants/receipts are untouched until an admin opts in.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants
      ADD COLUMN receipt_terms jsonb NOT NULL DEFAULT
        '["Training fees are strictly non-refundable under any circumstances.","A late fee of ₹50 per day applies to any installment paid after its due date."]'::jsonb,
      ADD COLUMN receipt_signatory_label text NOT NULL DEFAULT 'Authorized Signatory',
      ADD COLUMN receipt_no_prefix text,
      ADD COLUMN receipt_no_start integer NOT NULL DEFAULT 1,
      ADD COLUMN receipt_no_pad integer NOT NULL DEFAULT 5;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants
      DROP COLUMN IF EXISTS receipt_terms,
      DROP COLUMN IF EXISTS receipt_signatory_label,
      DROP COLUMN IF EXISTS receipt_no_prefix,
      DROP COLUMN IF EXISTS receipt_no_start,
      DROP COLUMN IF EXISTS receipt_no_pad;
  `);
};
