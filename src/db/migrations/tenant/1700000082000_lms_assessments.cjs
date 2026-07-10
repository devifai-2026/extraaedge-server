/* eslint-disable camelcase */
// LMS Phase 6: assessments — mock tests (MCQ), projects (live+github submit),
// and a derived leaderboard (tests + projects + attendance % + interview marks).
exports.up = (pgm) => {
  pgm.sql(`
    -- Mock tests: a titled set of MCQ questions with per-question marks.
    -- questions jsonb: [{ q, options:[...], correct_index, marks }]
    CREATE TABLE mock_tests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      module_id uuid REFERENCES course_modules(id) ON DELETE SET NULL,
      title text NOT NULL,
      questions jsonb NOT NULL DEFAULT '[]'::jsonb,
      total_marks numeric(8,2) NOT NULL DEFAULT 0,
      is_published boolean NOT NULL DEFAULT true,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON mock_tests (program_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_mock_tests_updated_at BEFORE UPDATE ON mock_tests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- One attempt per (test, student). answers jsonb: [option_index per question].
    CREATE TABLE mock_test_attempts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      test_id uuid NOT NULL REFERENCES mock_tests(id) ON DELETE CASCADE,
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      answers jsonb NOT NULL DEFAULT '[]'::jsonb,
      score numeric(8,2) NOT NULL DEFAULT 0,
      submitted_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX mock_test_attempts_uq ON mock_test_attempts (test_id, student_id);

    -- Projects: brief + deadline + marking scheme; students submit live+github.
    CREATE TABLE projects (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      module_id uuid REFERENCES course_modules(id) ON DELETE SET NULL,
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
    CREATE INDEX ON projects (program_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE project_submissions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      live_url text,
      github_url text,
      notes text,
      marks numeric(8,2),
      feedback text,
      graded_by uuid REFERENCES users(id) ON DELETE SET NULL,
      graded_at timestamptz,
      submitted_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX project_submissions_uq ON project_submissions (project_id, student_id);
    CREATE TRIGGER trg_project_submissions_updated_at BEFORE UPDATE ON project_submissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS project_submissions;
    DROP TABLE IF EXISTS projects;
    DROP TABLE IF EXISTS mock_test_attempts;
    DROP TABLE IF EXISTS mock_tests;
  `);
};
