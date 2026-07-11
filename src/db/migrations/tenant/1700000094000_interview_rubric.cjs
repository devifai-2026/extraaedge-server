/* eslint-disable camelcase */
// Mock-interview rubric: per-interview categories (Coding /30, Communication /20…)
// each scored_by 'trainer' or 'hr', and per-slot per-category scores. An HR
// evaluator can be assigned to the interview to score the soft-skill categories.
// interview_slots.marks stays the roll-up total (leaderboard reads it).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE mock_interviews ADD COLUMN IF NOT EXISTS hr_user_id uuid REFERENCES users(id) ON DELETE SET NULL;

    CREATE TABLE interview_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      interview_id uuid NOT NULL REFERENCES mock_interviews(id) ON DELETE CASCADE,
      name text NOT NULL,
      max_marks numeric(8,2) NOT NULL DEFAULT 10,
      scored_by text NOT NULL DEFAULT 'trainer',   -- 'trainer' | 'hr'
      order_index integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON interview_categories (interview_id);
    CREATE TRIGGER trg_interview_categories_updated_at BEFORE UPDATE ON interview_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE interview_slot_scores (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      slot_id uuid NOT NULL REFERENCES interview_slots(id) ON DELETE CASCADE,
      category_id uuid NOT NULL REFERENCES interview_categories(id) ON DELETE CASCADE,
      marks numeric(8,2) NOT NULL DEFAULT 0,
      scored_by_user uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX interview_slot_scores_uq ON interview_slot_scores (slot_id, category_id);
    CREATE TRIGGER trg_interview_slot_scores_updated_at BEFORE UPDATE ON interview_slot_scores FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS interview_slot_scores;
    DROP TABLE IF EXISTS interview_categories;
    ALTER TABLE mock_interviews DROP COLUMN IF EXISTS hr_user_id;
  `);
};
