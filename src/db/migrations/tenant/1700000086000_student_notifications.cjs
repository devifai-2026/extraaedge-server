/* eslint-disable camelcase */
// Student-facing notifications (separate principal from staff, so a separate
// store keyed by student_id). Fed by the events a student cares about: a new
// announcement, a graded test/project, an assigned/graded interview, and a
// trainer's forum reply. Rendered on the dashboard + as a bell later.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE student_notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      type text NOT NULL,                 -- announcement | test_graded | project_graded | interview_assigned | interview_graded | forum_answered
      message text NOT NULL,
      link text,                          -- student-app route to open
      metadata jsonb,
      is_read boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON student_notifications (student_id, is_read, created_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS student_notifications;`);
};
