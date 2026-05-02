// Tickets get a real `phone` column (autofilled from users.phone on submit
// when not provided) and a `target_user_id` column for the in-tenant
// reporting-chain colleague the ticket is routed to. Status flow stays on
// the existing enum: open | in_progress | resolved | closed.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS phone text;
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS target_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_tickets_target_user_id ON tickets (target_user_id);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE tickets DROP COLUMN IF EXISTS target_user_id;
    ALTER TABLE tickets DROP COLUMN IF EXISTS phone;
  `);
};
