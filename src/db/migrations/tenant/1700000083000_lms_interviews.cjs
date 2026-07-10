/* eslint-disable camelcase */
// LMS Phase 7: mock interviews. A trainer creates an interview (title + a
// manually-pasted meeting link) and assigns students to date/time slots; after
// each, the trainer records marks + feedback. Interview marks feed the
// leaderboard (see assessments/repo.leaderboard, which guards on this table).
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE mock_interviews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      title text NOT NULL,
      meeting_url text,
      max_marks numeric(8,2) NOT NULL DEFAULT 100,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON mock_interviews (program_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_mock_interviews_updated_at BEFORE UPDATE ON mock_interviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- One slot per assigned student, with a scheduled time + post-interview marks.
    CREATE TABLE interview_slots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      interview_id uuid NOT NULL REFERENCES mock_interviews(id) ON DELETE CASCADE,
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      slot_at timestamptz,
      marks numeric(8,2),
      feedback text,
      graded_by uuid REFERENCES users(id) ON DELETE SET NULL,
      graded_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE UNIQUE INDEX interview_slots_uq ON interview_slots (interview_id, student_id) WHERE deleted_at IS NULL;
    CREATE INDEX ON interview_slots (student_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_interview_slots_updated_at BEFORE UPDATE ON interview_slots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS interview_slots;
    DROP TABLE IF EXISTS mock_interviews;
  `);
};
