// System-DB map of Facebook Page ID → tenant, so the SINGLE app-level Lead Ads
// webhook (Facebook sends ALL pages' leadgen events to one App callback URL)
// can route each event to the right tenant by the page id in entry[].id.
// Written when a tenant connects a Page via OAuth.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS fb_page_tenants (
      page_id        text PRIMARY KEY,
      tenant_id      uuid NOT NULL,
      integration_id uuid,
      updated_at     timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_fb_page_tenants_tenant ON fb_page_tenants (tenant_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS fb_page_tenants;`);
};
