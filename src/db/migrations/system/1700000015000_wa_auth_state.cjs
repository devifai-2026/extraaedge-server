/**
 * Baileys WhatsApp auth-state store (system DB).
 *
 * The gateway links each user's WhatsApp via Baileys (no browser). Baileys'
 * auth state is a bag of small key/value blobs — `creds` plus per-category
 * signal keys (pre-keys, sessions, sender-keys, app-state-sync-keys). We persist
 * them here, one row per (tenant, user, data_key), so a gateway restart/redeploy
 * re-links without a fresh QR. Serialized as JSON via Baileys' BufferJSON.
 *
 * Lives in the SYSTEM db (not per-tenant) so the single gateway process has one
 * place to read/write every user's session, keyed by tenant_id + user_id.
 */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE wa_auth_state (
      tenant_id uuid NOT NULL,
      user_id   uuid NOT NULL,
      data_key  text NOT NULL,          -- 'creds' | '<category>-<id>'
      data_json jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_id, user_id, data_key)
    );
    CREATE INDEX wa_auth_state_tenant_user ON wa_auth_state (tenant_id, user_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS wa_auth_state;`);
};
