/* eslint-disable camelcase */
// Friendly per-tenant admission identifier in the form ADM-YYYY-NNNN.
//
// Rationale: the raw UUID was bleeding into the printable admission
// form and felt unprofessional ("Admission ID 297b48a0-..."). We add a
// short, human-readable code that's safe to surface to students /
// parents. The UUID stays as the primary key for everything internal —
// this column is purely a display alias.
//
// Sequence resets per calendar year (year_of(created_at)), which keeps
// the numbers compact and gives the org a natural rollover boundary.
// The mint logic lives in the service layer; this migration just adds
// the column + uniqueness + backfills existing rows.

exports.up = (pgm) => {
  pgm.sql(`
    -- 1. Add the column (nullable for the backfill window).
    ALTER TABLE admissions
      ADD COLUMN IF NOT EXISTS admission_code text;

    -- 2. Backfill existing rows. Number them sequentially within their
    --    created_at year, ordered by created_at (then by id for ties),
    --    so the earliest admission in 2026 becomes ADM-2026-0001 etc.
    --    Skips rows that already have a code (idempotent re-run).
    WITH numbered AS (
      SELECT id,
             EXTRACT(YEAR FROM created_at)::int AS yr,
             ROW_NUMBER() OVER (
               PARTITION BY EXTRACT(YEAR FROM created_at)
               ORDER BY created_at, id
             ) AS seq
        FROM admissions
       WHERE admission_code IS NULL
    )
    UPDATE admissions a
       SET admission_code =
         'ADM-' || numbered.yr || '-' || LPAD(numbered.seq::text, 4, '0')
      FROM numbered
     WHERE a.id = numbered.id;

    -- 3. Enforce uniqueness across active rows. We don't make the
    --    column NOT NULL — a brand new INSERT might land before the
    --    service-layer mint runs, and we'd rather not block writes on
    --    a constraint that a soft-deleted row could violate.
    CREATE UNIQUE INDEX IF NOT EXISTS admissions_admission_code_uq
      ON admissions (admission_code)
      WHERE admission_code IS NOT NULL AND deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS admissions_admission_code_uq;
    ALTER TABLE admissions DROP COLUMN IF EXISTS admission_code;
  `);
};
