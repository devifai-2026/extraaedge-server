/* eslint-disable camelcase */

// Module scheduling, trainer performance, class join tracking and mandatory
// end-of-class / end-of-module feedback.
//
// 1. MODULE DATES — course_modules gains start_date/end_date. Required at the
//    API for NEW modules, but nullable here: existing modules have no dates and
//    a NOT NULL would fail the migration or invent wrong ones. The performance
//    report treats a module with no end_date as "not scheduled" rather than
//    overdue, so old rows never show up as failures.
//
//    completed_at / completed_by / completion_note support the manual override:
//    a module auto-completes when every class under it is completed, and a
//    trainer may also mark it done early (finished the syllabus ahead of time).
//    Whichever happens first wins, and on_time is judged against end_date.
//
// 2. JOIN TRACKING — attendance.joined_at / join_count record that a student
//    actually clicked through to the class. This is what makes the portal
//    button dynamic ("Join Class" -> "Rejoin") and is separate from join_mode,
//    which is the student DECLARING how they will attend.
//
// 3. FEEDBACK — one table for both kinds, discriminated by scope:
//      class   → feedback on a single class, only from students marked present
//      module  → feedback at the end of a module
//    dismissed_count supports "skippable once but keeps coming back": the modal
//    can be dismissed, and returns on the next login until submitted.
//
// Ratings are 1..5 and the comment is optional — a mandatory essay gets
// garbage answers, a mandatory star does not.

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE course_modules ADD COLUMN IF NOT EXISTS start_date date;
    ALTER TABLE course_modules ADD COLUMN IF NOT EXISTS end_date date;
    ALTER TABLE course_modules ADD COLUMN IF NOT EXISTS completed_at timestamptz;
    ALTER TABLE course_modules ADD COLUMN IF NOT EXISTS completed_by uuid REFERENCES users(id) ON DELETE SET NULL;
    ALTER TABLE course_modules ADD COLUMN IF NOT EXISTS completion_note text;

    -- A module cannot end before it starts. Written as a CHECK rather than
    -- enforced only in the API so a bad backfill or a direct SQL fix can't
    -- create a negative-length module that the weeks calculation would render
    -- as "-2 weeks".
    ALTER TABLE course_modules DROP CONSTRAINT IF EXISTS course_modules_dates_chk;
    ALTER TABLE course_modules ADD CONSTRAINT course_modules_dates_chk
      CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date);

    ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_dates_chk;
    ALTER TABLE batches ADD CONSTRAINT batches_dates_chk
      CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date);

    -- Did the student actually open the class, and how many times.
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS joined_at timestamptz;
    ALTER TABLE attendance ADD COLUMN IF NOT EXISTS join_count integer NOT NULL DEFAULT 0;

    CREATE TABLE IF NOT EXISTS lms_feedback (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      scope text NOT NULL,                       -- class | module
      class_id uuid REFERENCES classes(id) ON DELETE CASCADE,
      module_id uuid REFERENCES course_modules(id) ON DELETE CASCADE,
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      trainer_id uuid REFERENCES users(id) ON DELETE SET NULL,
      -- NULLABLE on purpose: a dismissal writes this row before any rating
      -- exists. A placeholder rating would be counted in the trainer's average
      -- and quietly drag every score toward it.
      rating integer,                            -- 1..5 overall, NULL until submitted
      pace_rating integer,                       -- 1..5, module scope only
      clarity_rating integer,                    -- 1..5
      comment text,
      dismissed_count integer NOT NULL DEFAULT 0,
      submitted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    ALTER TABLE lms_feedback DROP CONSTRAINT IF EXISTS lms_feedback_scope_chk;
    ALTER TABLE lms_feedback ADD CONSTRAINT lms_feedback_scope_chk
      CHECK (
        (scope = 'class'  AND class_id  IS NOT NULL) OR
        (scope = 'module' AND module_id IS NOT NULL)
      );
    ALTER TABLE lms_feedback DROP CONSTRAINT IF EXISTS lms_feedback_rating_chk;
    ALTER TABLE lms_feedback ADD CONSTRAINT lms_feedback_rating_chk
      CHECK ((rating IS NULL OR rating BETWEEN 1 AND 5)
             AND (pace_rating    IS NULL OR pace_rating    BETWEEN 1 AND 5)
             AND (clarity_rating IS NULL OR clarity_rating BETWEEN 1 AND 5));

    -- One feedback row per student per class / per module. Partial uniques
    -- because class_id and module_id are each NULL for the other scope, and a
    -- plain unique over nullable columns would not collide.
    CREATE UNIQUE INDEX IF NOT EXISTS lms_feedback_class_uq
      ON lms_feedback (class_id, student_id) WHERE scope = 'class';
    CREATE UNIQUE INDEX IF NOT EXISTS lms_feedback_module_uq
      ON lms_feedback (module_id, student_id) WHERE scope = 'module';
    CREATE INDEX IF NOT EXISTS lms_feedback_trainer_idx ON lms_feedback (trainer_id);

    CREATE TRIGGER trg_lms_feedback_updated_at BEFORE UPDATE ON lms_feedback
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  // New tab for everyone who can see performance. Trainers see only their own
  // rows; the report scopes that server-side. Editing the tab constants only
  // grants NEW roles, so an existing tenant needs this backfill or the page
  // stays invisible however the code reads.
  pgm.sql(`
    UPDATE custom_roles
       SET tab_permissions = COALESCE(tab_permissions, '{}'::jsonb) || '{"trainer.performance":"full"}'::jsonb
     WHERE name IN ('trainer', 'head_trainer', 'branch_manager', 'super_admin')
       AND NOT (COALESCE(tab_permissions, '{}'::jsonb) ? 'trainer.performance');
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    UPDATE custom_roles SET tab_permissions = tab_permissions - 'trainer.performance'
     WHERE tab_permissions -> 'trainer.performance' = '"full"';
    DROP TABLE IF EXISTS lms_feedback;
    ALTER TABLE attendance DROP COLUMN IF EXISTS joined_at;
    ALTER TABLE attendance DROP COLUMN IF EXISTS join_count;
    ALTER TABLE course_modules DROP CONSTRAINT IF EXISTS course_modules_dates_chk;
    ALTER TABLE batches DROP CONSTRAINT IF EXISTS batches_dates_chk;
    ALTER TABLE course_modules DROP COLUMN IF EXISTS start_date;
    ALTER TABLE course_modules DROP COLUMN IF EXISTS end_date;
    ALTER TABLE course_modules DROP COLUMN IF EXISTS completed_at;
    ALTER TABLE course_modules DROP COLUMN IF EXISTS completed_by;
    ALTER TABLE course_modules DROP COLUMN IF EXISTS completion_note;
  `);
};
