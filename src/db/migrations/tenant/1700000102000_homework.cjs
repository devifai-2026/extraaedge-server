/* eslint-disable camelcase */
// Phase G9b — lightweight per-class/module HOMEWORK, distinct from the
// portfolio-grade `projects` (live URL + GitHub). Homework is a short assignment
// a student submits with a file upload + notes; the trainer grades it.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      module_id uuid REFERENCES course_modules(id) ON DELETE SET NULL,
      title text NOT NULL,
      brief text,
      deadline timestamptz,
      max_marks numeric(8,2) NOT NULL DEFAULT 10,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS assignments_program_idx ON assignments (program_id);
    CREATE TRIGGER trg_assignments_updated_at BEFORE UPDATE ON assignments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS assignment_submissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      assignment_id uuid NOT NULL REFERENCES assignments(id) ON DELETE CASCADE,
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      file_r2_key text,
      notes text,
      marks numeric(8,2),
      feedback text,
      graded_by uuid REFERENCES users(id) ON DELETE SET NULL,
      submitted_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS assignment_submissions_uq ON assignment_submissions (assignment_id, student_id);
    CREATE TRIGGER trg_assignment_submissions_updated_at BEFORE UPDATE ON assignment_submissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS assignment_submissions;
    DROP TABLE IF EXISTS assignments;
  `);
};
