// Per-tenant Facebook/Meta app config — mirrors wa_settings. Each tenant
// registers its OWN Meta app (App ID + App Secret) so the "Connect with
// Facebook" OAuth flow and Lead Ads / Custom Audiences run under that tenant's
// own app. App Secret is stored encrypted (AES via lib/crypto). Single-row.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS fb_settings (
      id boolean PRIMARY KEY DEFAULT true,       -- single-row guard (always true)
      enabled boolean NOT NULL DEFAULT false,
      app_id text,                                -- Meta App ID (public)
      app_secret_encrypted text,                 -- Meta App Secret (encrypted)
      graph_version text DEFAULT 'v19.0',
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT fb_settings_singleton CHECK (id = true)
    );
    INSERT INTO fb_settings (id) VALUES (true) ON CONFLICT DO NOTHING;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS fb_settings;`);
};
