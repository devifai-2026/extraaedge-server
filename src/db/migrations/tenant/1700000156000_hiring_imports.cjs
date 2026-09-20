/* eslint-disable camelcase */

// Async import jobs for Speedup Hiring.
//
// The first cut parsed the sheet inline and returned the verdict in the
// response. That does not survive contact with a real workbook: the global
// JSON body limit is 200kb, and a recruiter should not sit on a spinner while
// several hundred rows are validated and written.
//
// Same shape as the lead importer, which the recruiter already understands:
// upload the file, queue a job, poll for progress. Failed and duplicate rows
// are persisted per-row so they can be reviewed on their own tabs afterwards
// rather than vanishing with the response.

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS hiring_imports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- 'candidate' | 'interview' — which sheet, and so which mapping+table.
      kind text NOT NULL,
      file_key text,
      file_name text,
      sheet_name text,
      -- Fallback position when a row does not name one.
      position_id uuid REFERENCES hiring_positions(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'queued',
      total_rows int NOT NULL DEFAULT 0,
      created_rows int NOT NULL DEFAULT 0,
      updated_rows int NOT NULL DEFAULT 0,
      failed_rows int NOT NULL DEFAULT 0,
      duplicate_rows int NOT NULL DEFAULT 0,
      -- Status names in the sheet that match no configured status. Surfaced so
      -- the recruiter can add them and re-import rather than silently losing
      -- the outcome on every row.
      unknown_statuses jsonb NOT NULL DEFAULT '[]'::jsonb,
      error text,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      CONSTRAINT hiring_imports_kind_chk CHECK (kind IN ('candidate','interview')),
      CONSTRAINT hiring_imports_status_chk
        CHECK (status IN ('queued','processing','completed','failed'))
    );
    CREATE INDEX IF NOT EXISTS hiring_imports_created_idx ON hiring_imports (created_at DESC);

    -- One row per rejected or duplicate source row. Kept rather than returned
    -- once: "which 14 rows failed and why" is a question asked days later, and
    -- the raw payload lets someone fix the sheet without re-opening the file.
    CREATE TABLE IF NOT EXISTS hiring_import_rows (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      import_id uuid NOT NULL REFERENCES hiring_imports(id) ON DELETE CASCADE,
      row_no int NOT NULL,
      -- 'failed'   — rejected, nothing written
      -- 'duplicate'— matched an existing candidate, so it UPDATED rather than
      --              inserted. Not an error; recorded so the count is explainable.
      outcome text NOT NULL,
      reason text,
      raw jsonb,
      candidate_id uuid REFERENCES hiring_candidates(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT hiring_import_rows_outcome_chk CHECK (outcome IN ('failed','duplicate'))
    );
    CREATE INDEX IF NOT EXISTS hiring_import_rows_import_idx ON hiring_import_rows (import_id, outcome);
  `);

  // Its own tab, so failures and duplicates are reviewable without hunting
  // through the candidate list.
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb) || '{"hiring.imports":"full"}'::jsonb
     WHERE name IN ('hr_recruiter','hr_team_lead')
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'hiring.imports');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS hiring_import_rows;
    DROP TABLE IF EXISTS hiring_imports;
    UPDATE custom_roles SET tab_permissions = tab_permissions - 'hiring.imports'
     WHERE tab_permissions -> 'hiring.imports' = '"full"';
  `);
};
