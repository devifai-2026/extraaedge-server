// Back-pointer to system.support_tickets so PATCHing a tenant ticket can
// mirror the status change to the system row, and vice-versa from PO side.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE tickets ADD COLUMN IF NOT EXISTS system_ticket_id uuid;
    CREATE INDEX IF NOT EXISTS idx_tickets_system_ticket_id ON tickets (system_ticket_id);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE tickets DROP COLUMN IF EXISTS system_ticket_id;
  `);
};
