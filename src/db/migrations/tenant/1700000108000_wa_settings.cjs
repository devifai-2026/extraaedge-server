// Per-tenant WhatsApp configuration (multi-tenant).
//
// Each institute uses its OWN WhatsApp Business number via its OWN WABridge
// account, so credentials live per-tenant (here) — NOT in the server's global
// env. A single row per tenant DB. The webhook_token routes inbound: each
// tenant registers /whatsapp/webhook/<slug> in WABridge, and we verify the
// token to prevent cross-tenant spoofing.
exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE wa_settings (
      id boolean PRIMARY KEY DEFAULT true,      -- single-row guard (always true)
      enabled boolean NOT NULL DEFAULT false,
      wabridge_app_key text,
      wabridge_auth_key text,
      wabridge_device_id text,
      business_phone text,                      -- display: the tenant's WA number
      webhook_token text,                       -- per-tenant secret in the webhook URL
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT wa_settings_singleton CHECK (id = true)
    );
    INSERT INTO wa_settings (id) VALUES (true) ON CONFLICT DO NOTHING;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS wa_settings;`);
};
