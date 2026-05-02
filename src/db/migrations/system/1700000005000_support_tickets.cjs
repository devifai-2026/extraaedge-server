// System-wide support inbox for the Product Owner.
//
// Every super_admin ticket raised in any tenant is mirrored here so the PO
// can triage across tenants from a single inbox without ever opening a
// tenant DB. We snapshot the raiser's identity (name/email/phone/role) so
// the row stays meaningful even if the tenant user is later deleted.
// `tenant_ticket_id` is the back-pointer used to mirror status/comments
// updates in both directions.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      tenant_ticket_id uuid NOT NULL,
      raised_by_user_id uuid NOT NULL,
      raised_by_name text,
      raised_by_email text,
      raised_by_phone text,
      raised_by_role text,
      subject text NOT NULL,
      category text,
      priority text NOT NULL DEFAULT 'normal',
      description text,
      status text NOT NULL DEFAULT 'open',
      assigned_to_platform_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
      resolution_note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      deleted_at timestamptz,
      UNIQUE (tenant_id, tenant_ticket_id)
    );
    CREATE INDEX IF NOT EXISTS idx_support_tickets_status ON support_tickets (status);
    CREATE INDEX IF NOT EXISTS idx_support_tickets_tenant_id ON support_tickets (tenant_id, created_at DESC);

    -- updated_at trigger reuses the system DB helper.
    DROP TRIGGER IF EXISTS trg_support_tickets_updated_at ON support_tickets;
    CREATE TRIGGER trg_support_tickets_updated_at
      BEFORE UPDATE ON support_tickets
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE IF NOT EXISTS support_ticket_comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      support_ticket_id uuid NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      platform_user_id uuid REFERENCES platform_users(id) ON DELETE SET NULL,
      tenant_user_id uuid,
      author_name text,
      body text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_support_ticket_comments_ticket
      ON support_ticket_comments (support_ticket_id, created_at);
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    DROP TABLE IF EXISTS support_ticket_comments;
    DROP TABLE IF EXISTS support_tickets;
  `);
};
