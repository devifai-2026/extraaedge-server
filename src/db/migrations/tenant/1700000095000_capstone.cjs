/* eslint-disable camelcase */
// Course-level capstone projects (distinct from per-module projects): one brief
// per course, students submit a live URL + GitHub + optional file, trainer/head
// grades. "Capstone submitted" is a placement-eligibility signal.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE capstone_projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      title text NOT NULL,
      brief text,
      marking_scheme text,
      max_marks numeric(8,2) NOT NULL DEFAULT 100,
      deadline timestamptz,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON capstone_projects (program_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_capstone_projects_updated_at BEFORE UPDATE ON capstone_projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE capstone_submissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      capstone_id uuid NOT NULL REFERENCES capstone_projects(id) ON DELETE CASCADE,
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      live_url text,
      github_url text,
      file_r2_key text,
      marks numeric(8,2),
      feedback text,
      graded_by uuid REFERENCES users(id) ON DELETE SET NULL,
      graded_at timestamptz,
      submitted_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX capstone_submissions_uq ON capstone_submissions (capstone_id, student_id);
    CREATE TRIGGER trg_capstone_submissions_updated_at BEFORE UPDATE ON capstone_submissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS capstone_submissions;
    DROP TABLE IF EXISTS capstone_projects;
  `);
};
