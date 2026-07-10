/* eslint-disable camelcase */
// LMS Phase 5: student doubt forum. A student opens a thread (scoped to their
// course), optionally @mentioning trainers (stored as user ids); mentioned
// trainers are notified. Trainers and the student reply on the thread.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE forum_threads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      student_id uuid NOT NULL REFERENCES students(id) ON DELETE CASCADE,
      title text NOT NULL,
      body text NOT NULL,
      mentions uuid[] NOT NULL DEFAULT '{}',       -- mentioned trainer user ids
      status text NOT NULL DEFAULT 'open',          -- open | answered | closed
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON forum_threads (program_id, created_at DESC) WHERE deleted_at IS NULL;
    CREATE INDEX ON forum_threads (student_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_forum_threads_updated_at BEFORE UPDATE ON forum_threads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE forum_replies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id uuid NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
      author_kind text NOT NULL,                    -- user | student
      author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      author_student_id uuid REFERENCES students(id) ON DELETE SET NULL,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON forum_replies (thread_id, created_at) WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS forum_replies;
    DROP TABLE IF EXISTS forum_threads;
  `);
};
