/* eslint-disable camelcase */
// LMS Phase 3: classes, recordings, and live-MCQ attendance.
//
// A class targets exactly ONE batch (single-batch model). The trainer drives
// the class lifecycle (start/end) which doubles as their own attendance, and
// fires attendance MCQ questions (from a per-module bank or ad-hoc) each with a
// visible-minutes window; a student is "present" only after answering EVERY
// fired question within its window. Recording access is gated later by the
// student's batch_students.recordings_from cutoff.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE classes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      module_id uuid REFERENCES course_modules(id) ON DELETE SET NULL,
      batch_id uuid NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
      title text NOT NULL,
      kind text NOT NULL DEFAULT 'lecture',       -- lecture | mock_test
      mode text NOT NULL DEFAULT 'online',         -- online | offline
      meeting_url text,                            -- trainer pastes GMeet/Teams link
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      started_at timestamptz,                      -- set when trainer marks "start"
      ended_at timestamptz,                        -- set when trainer marks "end"
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON classes (batch_id) WHERE deleted_at IS NULL;
    CREATE INDEX ON classes (program_id, starts_at) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_classes_updated_at BEFORE UPDATE ON classes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Trainer self-attendance / class-lifecycle log.
    CREATE TABLE trainer_attendance (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      trainer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action text NOT NULL,                        -- class_started | class_ended | mock_test
      marked_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON trainer_attendance (class_id);

    -- Reusable per-module attendance question bank.
    CREATE TABLE attendance_bank_questions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      module_id uuid NOT NULL REFERENCES course_modules(id) ON DELETE CASCADE,
      question text NOT NULL,
      options jsonb NOT NULL DEFAULT '[]'::jsonb,   -- ["A","B","C"]
      correct_index integer,                        -- optional (attendance != scored)
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON attendance_bank_questions (module_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_attendance_bank_updated_at BEFORE UPDATE ON attendance_bank_questions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- A question FIRED during a class (from the bank or ad-hoc). visible_minutes
    -- is the student answer window; closes_at = fired_at + visible_minutes.
    CREATE TABLE attendance_questions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      question text NOT NULL,
      options jsonb NOT NULL DEFAULT '[]'::jsonb,
      correct_index integer,
      source text NOT NULL DEFAULT 'adhoc',         -- bank | adhoc
      visible_minutes integer NOT NULL DEFAULT 5,
      fired_at timestamptz NOT NULL DEFAULT now(),
      closes_at timestamptz NOT NULL,
      fired_by uuid REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX ON attendance_questions (class_id);

    -- A student's answer to a fired question.
    CREATE TABLE attendance_answers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      question_id uuid NOT NULL REFERENCES attendance_questions(id) ON DELETE CASCADE,
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      option_index integer NOT NULL,
      answered_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX attendance_answers_uq ON attendance_answers (question_id, student_id);

    -- Final per-student attendance for a class. status computed server-side
    -- ("present" = answered ALL fired questions within window) but stored so
    -- trainers can override (edited_by flag) + pre-notified absence is recorded.
    CREATE TABLE attendance (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      status text NOT NULL DEFAULT 'absent',        -- present | absent
      join_mode text,                               -- online | offline
      pre_notified_absent boolean NOT NULL DEFAULT false,
      edited_by uuid REFERENCES users(id) ON DELETE SET NULL,
      edited_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX attendance_uq ON attendance (class_id, student_id);
    CREATE TRIGGER trg_attendance_updated_at BEFORE UPDATE ON attendance FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE class_recordings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      class_id uuid NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
      r2_key text NOT NULL,
      label text,
      uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON class_recordings (class_id) WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS class_recordings;
    DROP TABLE IF EXISTS attendance;
    DROP TABLE IF EXISTS attendance_answers;
    DROP TABLE IF EXISTS attendance_questions;
    DROP TABLE IF EXISTS attendance_bank_questions;
    DROP TABLE IF EXISTS trainer_attendance;
    DROP TABLE IF EXISTS classes;
  `);
};
