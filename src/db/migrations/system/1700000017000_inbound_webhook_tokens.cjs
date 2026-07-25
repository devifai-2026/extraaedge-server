// System-DB map of inbound-webhook secret token → tenant, so the UNauthenticated
// receiver POST /api/v1/integrations/inbound/:token can resolve which tenant a
// token belongs to in O(1) (no cross-tenant DB scan). Written when a tenant
// mints a webhook URL for an integration; the per-tenant `inbound_webhooks`
// row remains the source of truth for field mapping/config.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS inbound_webhook_tokens (
      token          text PRIMARY KEY,
      tenant_id      uuid NOT NULL,
      integration_id uuid,
      integration_type text,
      created_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_inbound_webhook_tokens_tenant ON inbound_webhook_tokens (tenant_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS inbound_webhook_tokens;`);
};
