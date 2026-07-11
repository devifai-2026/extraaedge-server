/* eslint-disable camelcase */
// Phase G9c — trainer leave. A trainer marks themselves unavailable for a date
// range with a reason; the head trainer / admin sees the roster's leaves and can
// reassign affected classes to a substitute (the classes.trainer_id edit already
// exists). Status lets a head approve/decline if desired (default 'approved' —
// self-service leave record).

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS trainer_leave (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      trainer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      from_date date NOT NULL,
      to_date date NOT NULL,
      reason text,
      status text NOT NULL DEFAULT 'approved',   -- 'approved' | 'declined' | 'pending'
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS trainer_leave_trainer_idx ON trainer_leave (trainer_id, from_date);
    CREATE TRIGGER trg_trainer_leave_updated_at BEFORE UPDATE ON trainer_leave FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS trainer_leave;`);
};
