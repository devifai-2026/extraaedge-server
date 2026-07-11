/* eslint-disable camelcase */
// LMS learning layer: study-materials library, per-module student progress,
// course-completion certificates, and a daily activity streak (for
// gamification badges, which are otherwise computed on the fly).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    -- ---- Study materials (files uploaded to GCS, or external links) ----
    CREATE TABLE course_materials (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      module_id uuid REFERENCES course_modules(id) ON DELETE SET NULL,
      title text NOT NULL,
      description text,
      kind text NOT NULL DEFAULT 'file',          -- 'file' | 'link'
      r2_key text,                                -- set when kind='file'
      url text,                                   -- set when kind='link'
      file_name text,
      content_type text,
      size_bytes bigint,
      uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON course_materials (program_id) WHERE deleted_at IS NULL;
    CREATE INDEX ON course_materials (module_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_course_materials_updated_at BEFORE UPDATE ON course_materials FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ---- Per-module completion (student self-marks a module done) ----
    CREATE TABLE student_module_progress (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      module_id uuid NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
      completed_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX student_module_progress_uq ON student_module_progress (student_id, module_id);
    CREATE INDEX ON student_module_progress (program_id);
    CREATE TRIGGER trg_student_module_progress_updated_at BEFORE UPDATE ON student_module_progress FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ---- Completion certificates (one live cert per student+course) ----
    CREATE TABLE certificates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      certificate_number text NOT NULL,
      r2_key text,                                -- optional stored PDF (FE renders live otherwise)
      issued_by uuid REFERENCES users(id) ON DELETE SET NULL,   -- NULL = student self-claimed
      meta jsonb NOT NULL DEFAULT '{}'::jsonb,    -- snapshot: attendance %, avg score, modules
      issued_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE UNIQUE INDEX certificates_student_program_uq ON certificates (student_id, program_id) WHERE deleted_at IS NULL;
    CREATE INDEX ON certificates (program_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_certificates_updated_at BEFORE UPDATE ON certificates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- ---- Daily activity streak (drives gamification) ----
    CREATE TABLE student_activity (
      student_id uuid PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
      last_active_date date,
      current_streak integer NOT NULL DEFAULT 0,
      longest_streak integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER trg_student_activity_updated_at BEFORE UPDATE ON student_activity FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS student_activity;
    DROP TABLE IF EXISTS certificates;
    DROP TABLE IF EXISTS student_module_progress;
    DROP TABLE IF EXISTS course_materials;
  `);
};
