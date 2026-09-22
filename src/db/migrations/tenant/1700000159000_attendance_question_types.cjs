/* eslint-disable camelcase */

// Attendance questions gain a TYPE (mcq | true_false | long_text) and the
// trainer finally gets to nominate the correct answer while firing one.
//
// `correct_index` already existed on both question tables but nothing ever set
// it: the trainer console had no control for it, so every fired question stored
// NULL and no report could say who answered correctly. This migration adds the
// type discriminator and the free-text answer column long_text needs, then
// leaves existing rows as 'mcq' via the column default so old data keeps its
// meaning.
//
// SHAPES
//   mcq         options = ["A","B",...],   answer = option_index
//   true_false  options = ["True","False"] (seeded server-side), answer = option_index
//   long_text   options = [],              answer = answer_text
//
// GRADING
//   mcq / true_false  auto-graded against correct_index.
//   long_text         NOT auto-graded — the trainer reads the answers and may
//                     mark each one by hand (attendance_answers.is_correct_override).
//                     Left NULL it stays "ungraded", a distinct state from wrong.
//
// ATTENDANCE IS UNCHANGED: answering marks a student present whether the answer
// is right or wrong. Correctness is reported separately.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE attendance_bank_questions
      ADD COLUMN IF NOT EXISTS question_type text NOT NULL DEFAULT 'mcq';
    ALTER TABLE attendance_questions
      ADD COLUMN IF NOT EXISTS question_type text NOT NULL DEFAULT 'mcq';

    -- Free-text student answer. option_index stays NOT NULL for the choice
    -- kinds, so long_text rows park a sentinel -1 there and carry the real
    -- answer here.
    ALTER TABLE attendance_answers
      ADD COLUMN IF NOT EXISTS answer_text text;

    -- Trainer's manual verdict on a long_text answer. NULL = not yet reviewed,
    -- which analytics reports as "ungraded" rather than "wrong".
    ALTER TABLE attendance_answers
      ADD COLUMN IF NOT EXISTS is_correct_override boolean;
    ALTER TABLE attendance_answers
      ADD COLUMN IF NOT EXISTS graded_by uuid REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE attendance_answers
      ADD COLUMN IF NOT EXISTS graded_at timestamptz;

    -- Constrain the type only after the default has populated existing rows
    -- (all MCQ by construction), so the backfill cannot violate it.
    ALTER TABLE attendance_bank_questions
      DROP CONSTRAINT IF EXISTS attendance_bank_questions_type_chk;
    ALTER TABLE attendance_bank_questions
      ADD CONSTRAINT attendance_bank_questions_type_chk
      CHECK (question_type IN ('mcq','true_false','long_text'));

    ALTER TABLE attendance_questions
      DROP CONSTRAINT IF EXISTS attendance_questions_type_chk;
    ALTER TABLE attendance_questions
      ADD CONSTRAINT attendance_questions_type_chk
      CHECK (question_type IN ('mcq','true_false','long_text'));

    CREATE INDEX IF NOT EXISTS attendance_answers_question_idx
      ON attendance_answers (question_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE attendance_bank_questions DROP CONSTRAINT IF EXISTS attendance_bank_questions_type_chk;
    ALTER TABLE attendance_questions      DROP CONSTRAINT IF EXISTS attendance_questions_type_chk;
    ALTER TABLE attendance_bank_questions DROP COLUMN IF EXISTS question_type;
    ALTER TABLE attendance_questions      DROP COLUMN IF EXISTS question_type;
    ALTER TABLE attendance_answers        DROP COLUMN IF EXISTS answer_text;
    ALTER TABLE attendance_answers        DROP COLUMN IF EXISTS is_correct_override;
    ALTER TABLE attendance_answers        DROP COLUMN IF EXISTS graded_by;
    ALTER TABLE attendance_answers        DROP COLUMN IF EXISTS graded_at;
  `);
};
