/* eslint-disable camelcase */
// LMS Phase 4: course announcements — threads with comments + likes.
//
// Scope: an announcement targets a course (program), optionally a specific
// batch. Trainers post; a recording upload auto-posts one (author_kind='system'
// with a class_id link). Students of the course/batch see them and can comment
// + like. Author can be a staff user OR a student (comments), so we key by
// author_kind + the matching id column.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE announcements (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      program_id uuid NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
      batch_id uuid REFERENCES batches(id) ON DELETE SET NULL,    -- null = whole course
      class_id uuid REFERENCES classes(id) ON DELETE SET NULL,     -- set when auto-posted from a recording
      title text,
      body text NOT NULL,
      author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      auto_source text,                                            -- e.g. 'recording' | null
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON announcements (program_id, created_at DESC) WHERE deleted_at IS NULL;
    CREATE INDEX ON announcements (batch_id) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_announcements_updated_at BEFORE UPDATE ON announcements FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE announcement_comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      author_kind text NOT NULL,                                   -- user | student
      author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      author_student_id uuid REFERENCES students(id) ON DELETE SET NULL,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON announcement_comments (announcement_id, created_at) WHERE deleted_at IS NULL;

    -- One like per (announcement, actor). actor is a user OR a student.
    CREATE TABLE announcement_likes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      student_id uuid REFERENCES students(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX announcement_likes_user_uq ON announcement_likes (announcement_id, user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX announcement_likes_student_uq ON announcement_likes (announcement_id, student_id) WHERE student_id IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS announcement_likes;
    DROP TABLE IF EXISTS announcement_comments;
    DROP TABLE IF EXISTS announcements;
  `);
};
