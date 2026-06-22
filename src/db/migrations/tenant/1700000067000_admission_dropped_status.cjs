/* eslint-disable camelcase */
// Accounts can DROP a converted student (e.g. withdrew / no-show after
// enrollment). Adds a 'dropped' status to admissions + audit columns. Dropped
// students stop generating follow-up reminders (the drop service cancels their
// lead's planned follow-ups) and surface in a dedicated "Drop Candidates" tab.
exports.up = (pgm) => {
  pgm.sql(`
    -- Replace the inline status CHECK to allow 'dropped'. The original is an
    -- unnamed table constraint; drop whichever CHECK currently governs status,
    -- then add a named one we can manage going forward.
    DO $$
    DECLARE c text;
    BEGIN
      SELECT con.conname INTO c
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
       WHERE rel.relname = 'admissions' AND con.contype = 'c'
         AND pg_get_constraintdef(con.oid) ILIKE '%status%';
      IF c IS NOT NULL THEN
        EXECUTE format('ALTER TABLE admissions DROP CONSTRAINT %I', c);
      END IF;
    END $$;

    ALTER TABLE admissions
      ADD CONSTRAINT admissions_status_check
      CHECK (status IN ('pending_approval', 'attending', 'on_break', 'completed', 'rejected', 'dropped'));

    ALTER TABLE admissions
      ADD COLUMN IF NOT EXISTS dropped_at timestamptz,
      ADD COLUMN IF NOT EXISTS dropped_reason text,
      ADD COLUMN IF NOT EXISTS dropped_by uuid REFERENCES users(id) ON DELETE SET NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE admissions
      DROP COLUMN IF EXISTS dropped_at,
      DROP COLUMN IF EXISTS dropped_reason,
      DROP COLUMN IF EXISTS dropped_by;
    ALTER TABLE admissions DROP CONSTRAINT IF EXISTS admissions_status_check;
    ALTER TABLE admissions
      ADD CONSTRAINT admissions_status_check
      CHECK (status IN ('pending_approval', 'attending', 'on_break', 'completed', 'rejected'));
  `);
};
