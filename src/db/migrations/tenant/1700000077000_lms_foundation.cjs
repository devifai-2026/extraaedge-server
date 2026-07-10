/* eslint-disable camelcase */
// LMS foundation (Phase 1): course structure + enrolment.
//
// A "course" is an existing programs row. On top of it we add:
//   - course_modules   : the modules of a course (MERN -> HTML/CSS/JS)
//   - course_trainers   : who teaches the course (head + module trainers) — the
//                         server-side scope table (mirrors guided_by_counsellor_id)
//   - batches           : parallel cohorts of a course (MERN-Aug, MERN-Sep…)
//   - batch_students    : cohort membership, with a per-student recordings cutoff
//   - module_batches    : which batches a trainer covers within their module
//   - students          : the authenticated learner (email+password), created at
//                         Accounts "course-confirm"
// Plus admissions gains course-confirm bookkeeping columns.
//
// Classes / attendance / community / assessments arrive in later-phase
// migrations so each phase boots independently.
exports.up = (pgm) => {
  pgm.sql(`
    -- Modules of a course (ordered). syllabus is free-form JSON (topics/links).
    CREATE TABLE course_modules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      name text NOT NULL,
      description text,
      order_index integer NOT NULL DEFAULT 0,
      syllabus jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON course_modules (program_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_course_modules_updated_at BEFORE UPDATE ON course_modules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Course teaching roster. role = head | trainer. module_id NULL for the head
    -- (course-wide); set for a module trainer. This is the trainer-scope table:
    -- a trainer may only act on courses where they have a row here.
    CREATE TABLE course_trainers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'trainer',      -- head | trainer
      module_id uuid REFERENCES course_modules(id) ON DELETE SET NULL,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON course_trainers (program_id) WHERE deleted_at IS NULL;
    CREATE INDEX ON course_trainers (user_id) WHERE deleted_at IS NULL;
    -- One head per course (partial unique on role='head').
    CREATE UNIQUE INDEX course_trainers_one_head ON course_trainers (program_id)
      WHERE role = 'head' AND deleted_at IS NULL;
    CREATE TRIGGER trg_course_trainers_updated_at BEFORE UPDATE ON course_trainers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Batches (cohorts) of a course. merged_into_batch_id set when this batch
    -- was merged into another (soft link; membership re-pointed, history kept).
    CREATE TABLE batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      name text NOT NULL,
      start_date date,
      end_date date,
      status text NOT NULL DEFAULT 'active',     -- active | merged | completed
      merged_into_batch_id uuid REFERENCES batches(id) ON DELETE SET NULL,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON batches (program_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_batches_updated_at BEFORE UPDATE ON batches FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- The authenticated learner. Created at Accounts "course-confirm" from an
    -- admission. Separate principal from staff users — its own email+password.
    CREATE TABLE students (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      admission_id uuid REFERENCES admissions(id) ON DELETE SET NULL,
      program_id uuid REFERENCES programs(id) ON DELETE SET NULL,
      name text NOT NULL,
      email citext NOT NULL,
      phone text,
      password_hash text,                        -- NULL until the set-password link is used
      status text NOT NULL DEFAULT 'pending',    -- pending | active | suspended
      set_password_token text,                   -- one-time token (hashed)
      set_password_expires_at timestamptz,
      last_login_at timestamptz,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    -- Email is the login key — unique across active students.
    CREATE UNIQUE INDEX students_email_uq ON students (email) WHERE deleted_at IS NULL;
    CREATE INDEX ON students (program_id) WHERE deleted_at IS NULL;
    CREATE INDEX ON students (admission_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_students_updated_at BEFORE UPDATE ON students FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Batch membership. recordings_from = the back-catalog cutoff for a
    -- mid-course joiner (NULL => only classes from joined_at onward). The head
    -- sets it to the batch start to share prior recordings.
    CREATE TABLE batch_students (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      joined_at timestamptz NOT NULL DEFAULT now(),
      recordings_from timestamptz,
      moved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    -- A student sits in at most one active batch per membership row.
    CREATE UNIQUE INDEX batch_students_uq ON batch_students (batch_id, student_id) WHERE deleted_at IS NULL;
    CREATE INDEX ON batch_students (student_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_batch_students_updated_at BEFORE UPDATE ON batch_students FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Which batches a trainer covers within a module they teach. (Organisational
    -- link only — a class still targets exactly one batch.)
    CREATE TABLE module_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      module_id uuid NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
      batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE UNIQUE INDEX module_batches_uq ON module_batches (module_id, batch_id) WHERE deleted_at IS NULL;

    -- Admissions course-confirm bookkeeping (the Accounts step after approve).
    ALTER TABLE admissions
      ADD COLUMN IF NOT EXISTS course_confirmed_at timestamptz,
      ADD COLUMN IF NOT EXISTS course_confirmed_by uuid REFERENCES users(id) ON DELETE SET NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE admissions
      DROP COLUMN IF EXISTS course_confirmed_at,
      DROP COLUMN IF EXISTS course_confirmed_by;
    DROP TABLE IF EXISTS module_batches;
    DROP TABLE IF EXISTS batch_students;
    DROP TABLE IF EXISTS students;
    DROP TABLE IF EXISTS batches;
    DROP TABLE IF EXISTS course_trainers;
    DROP TABLE IF EXISTS course_modules;
  `);
};
