/* eslint-disable camelcase */
// Tag bulk imports with WHAT they import.
//
// Until now every row in bulk_imports / bulk_import_previews was a lead
// upload, so the tables carried no discriminator. The Accounts team now
// needs a second importer — historical admissions migrated off their old
// CRM (student + fee offer + EMI schedule + already-collected receipts).
//
// Rather than clone four tables (previews / imports / failures /
// duplicates) plus their listing, retry and file-redownload routes, we add
// a `kind` column and let both importers share the machinery. Each
// listing endpoint filters on its own kind so the Bulk Upload List page
// and the Accounts import page never show each other's rows.
//
// Existing rows are all lead uploads, hence DEFAULT 'leads'.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE bulk_imports
      ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'leads';
    ALTER TABLE bulk_import_previews
      ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'leads';

    -- Named CHECKs so a future kind can be added by replacing one constraint.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'bulk_imports_kind_check'
      ) THEN
        ALTER TABLE bulk_imports
          ADD CONSTRAINT bulk_imports_kind_check
          CHECK (kind IN ('leads', 'admissions'));
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'bulk_import_previews_kind_check'
      ) THEN
        ALTER TABLE bulk_import_previews
          ADD CONSTRAINT bulk_import_previews_kind_check
          CHECK (kind IN ('leads', 'admissions'));
      END IF;
    END $$;

    -- The listing queries are "newest first, filtered by kind (+ uploader)".
    CREATE INDEX IF NOT EXISTS bulk_imports_kind_created_idx
      ON bulk_imports (kind, created_at DESC);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP INDEX IF EXISTS bulk_imports_kind_created_idx;
    ALTER TABLE bulk_imports DROP CONSTRAINT IF EXISTS bulk_imports_kind_check;
    ALTER TABLE bulk_import_previews DROP CONSTRAINT IF EXISTS bulk_import_previews_kind_check;
    ALTER TABLE bulk_imports DROP COLUMN IF EXISTS kind;
    ALTER TABLE bulk_import_previews DROP COLUMN IF EXISTS kind;
  `);
};
