/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`
    -- Integrations (3rd-party)
    CREATE TABLE integrations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      type text NOT NULL,                        -- facebook_ads | google_ads | zapier | custom_api | sendgrid | webhook_inbound
      name text NOT NULL,
      credentials_encrypted jsonb,
      config_json jsonb,
      status text NOT NULL DEFAULT 'unpublished', -- published | unpublished | error
      last_health_check_at timestamptz,
      last_error text,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON integrations (type);
    CREATE INDEX ON integrations (status) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_integrations_updated_at BEFORE UPDATE ON integrations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Inbound (for external systems to push into us)
    CREATE TABLE inbound_webhooks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
      secret_token text NOT NULL UNIQUE,
      field_mapping_json jsonb,
      default_channel text,
      default_source text,
      default_stage text,
      hit_count integer NOT NULL DEFAULT 0,
      last_hit_at timestamptz,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON inbound_webhooks (integration_id);
    CREATE TRIGGER trg_inbound_webhooks_updated_at BEFORE UPDATE ON inbound_webhooks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE webhook_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      integration_id uuid REFERENCES integrations(id) ON DELETE SET NULL,
      event_type text,
      payload_json jsonb NOT NULL,
      processed_at timestamptz,
      status text NOT NULL DEFAULT 'pending',    -- pending | processed | failed
      error text,
      received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON webhook_events (integration_id, received_at DESC);
    CREATE INDEX ON webhook_events (status);

    -- Outbound (tenant subscribes to our events)
    CREATE TABLE outbound_webhooks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      target_url text NOT NULL,
      secret text NOT NULL,
      event_types text[] NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      custom_headers_json jsonb,
      retry_config_json jsonb NOT NULL DEFAULT '{"max":5,"backoff_ms":[30000,120000,600000,3600000,21600000]}'::jsonb,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX outbound_webhooks_events_idx ON outbound_webhooks USING gin (event_types);
    CREATE TRIGGER trg_outbound_webhooks_updated_at BEFORE UPDATE ON outbound_webhooks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE outbound_webhook_deliveries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      webhook_id uuid NOT NULL REFERENCES outbound_webhooks(id) ON DELETE CASCADE,
      event_id uuid,
      event_type text NOT NULL,
      payload_json jsonb NOT NULL,
      signature text,
      attempt integer NOT NULL DEFAULT 0,
      status text NOT NULL DEFAULT 'pending',    -- pending | delivered | failed | dead
      response_code integer,
      response_body text,
      scheduled_for timestamptz NOT NULL DEFAULT now(),
      delivered_at timestamptz,
      failed_at timestamptz,
      next_retry_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON outbound_webhook_deliveries (status, next_retry_at) WHERE status IN ('pending','failed');
    CREATE INDEX ON outbound_webhook_deliveries (webhook_id, created_at DESC);

    -- Facebook remarketing (audiences)
    CREATE TABLE fb_ad_accounts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ad_account_id text NOT NULL UNIQUE,
      name text NOT NULL,
      access_token_encrypted text NOT NULL,
      connected_by uuid REFERENCES users(id) ON DELETE SET NULL,
      connected_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );

    CREATE TABLE fb_audiences (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      fb_ad_account_id uuid REFERENCES fb_ad_accounts(id) ON DELETE CASCADE,
      name text NOT NULL,
      description text,
      audience_filter_json jsonb NOT NULL,
      fb_audience_id text,
      lead_count integer NOT NULL DEFAULT 0,
      last_synced_at timestamptz,
      sync_status text NOT NULL DEFAULT 'pending', -- pending | synced | failed
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON fb_audiences (fb_ad_account_id);
    CREATE TRIGGER trg_fb_audiences_updated_at BEFORE UPDATE ON fb_audiences FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- OTP verification bookkeeping
    CREATE TABLE otp_verifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE CASCADE,
      purpose text NOT NULL,                     -- mobile_verify | email_verify | 2fa
      channel text NOT NULL,                     -- sms | email
      address text NOT NULL,                     -- phone or email being verified
      otp_hash text NOT NULL,
      provider_verification_id text,
      expires_at timestamptz NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 3,
      verified_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON otp_verifications (address, purpose, expires_at) WHERE verified_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS otp_verifications;
    DROP TABLE IF EXISTS fb_audiences;
    DROP TABLE IF EXISTS fb_ad_accounts;
    DROP TABLE IF EXISTS outbound_webhook_deliveries;
    DROP TABLE IF EXISTS outbound_webhooks;
    DROP TABLE IF EXISTS webhook_events;
    DROP TABLE IF EXISTS inbound_webhooks;
    DROP TABLE IF EXISTS integrations;
  `);
};
