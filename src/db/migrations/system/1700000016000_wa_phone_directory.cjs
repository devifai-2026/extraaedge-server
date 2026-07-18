// Multi-tenant WhatsApp webhook routing.
//
// One Meta WhatsApp Business number → one webhook, but extraaedge is DB-per-
// tenant. When an inbound message arrives we must decide which tenant owns it.
// This system-DB index maps a phone's last-10 digits → tenant, so the webhook
// can route in one lookup instead of scanning every tenant's leads. It's a
// best-effort cache: populated when a lead with a phone is created/updated, and
// the webhook falls back to WA_DEFAULT_TENANT_SLUG for unknown senders.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE wa_phone_directory (
      phone_last10 text NOT NULL,
      tenant_id uuid NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (phone_last10, tenant_id)
    );
    CREATE INDEX wa_phone_directory_phone ON wa_phone_directory (phone_last10);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS wa_phone_directory;`);
};
