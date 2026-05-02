/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`
    -- Templates
    CREATE TABLE email_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      subject text NOT NULL,
      body_html text,
      body_text text,
      variables text[],
      language text NOT NULL DEFAULT 'en',
      category text,
      status text NOT NULL DEFAULT 'Draft',        -- Published | Draft | Archived
      is_visible boolean NOT NULL DEFAULT true,
      builder_type text NOT NULL DEFAULT 'basic',  -- basic | advanced
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      UNIQUE (name, language)
    );
    CREATE INDEX ON email_templates (language) WHERE deleted_at IS NULL;
    CREATE INDEX ON email_templates (status);
    CREATE TRIGGER trg_email_templates_updated_at BEFORE UPDATE ON email_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE sms_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      body text NOT NULL,
      dlt_template_id text,
      dlt_entity_id text,
      variables text[],
      language text NOT NULL DEFAULT 'en',
      is_visible boolean NOT NULL DEFAULT true,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      UNIQUE (name, language)
    );
    CREATE TRIGGER trg_sms_templates_updated_at BEFORE UPDATE ON sms_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE whatsapp_templates (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      wabridge_template_name text NOT NULL,
      language text NOT NULL,
      category text,                               -- MARKETING | UTILITY | AUTHENTICATION
      body text,
      footer text,
      header_type text,
      buttons_json jsonb,
      variables text[],
      status text NOT NULL DEFAULT 'PENDING',      -- APPROVED | PENDING | REJECTED
      is_visible boolean NOT NULL DEFAULT true,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      UNIQUE (wabridge_template_name, language)
    );
    CREATE TRIGGER trg_whatsapp_templates_updated_at BEFORE UPDATE ON whatsapp_templates FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Template variable registry (seeded)
    CREATE TABLE template_variables (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      key text NOT NULL UNIQUE,
      label text NOT NULL,
      example text,
      resolver_function text NOT NULL,           -- name of fn in templating.js
      scope text[] NOT NULL,                     -- email | sms | whatsapp
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    -- Unified outbound log
    CREATE TABLE message_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      channel text NOT NULL,                     -- email | sms | whatsapp
      template_id uuid,
      language text,
      recipient text NOT NULL,
      provider text NOT NULL,
      provider_message_id text,
      status text NOT NULL DEFAULT 'queued',     -- queued | sent | delivered | failed | seen | clicked | bounced | unsubscribed | suppressed
      error text,
      campaign_id uuid,
      workflow_run_id uuid,
      scheduled_send_id uuid,
      scheduled_for timestamptz,
      sent_at timestamptz,
      delivered_at timestamptz,
      seen_at timestamptz,
      clicked_at timestamptz,
      failed_at timestamptz
    );
    CREATE INDEX ON message_log (lead_id, channel, sent_at DESC);
    CREATE INDEX ON message_log (campaign_id);
    CREATE INDEX ON message_log (workflow_run_id);
    CREATE INDEX ON message_log (status, channel);
    CREATE INDEX ON message_log (provider_message_id);

    CREATE TABLE message_reply (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
      channel text NOT NULL,
      provider_message_id text,
      body text,
      media_urls text[],
      received_at timestamptz NOT NULL DEFAULT now(),
      routed_to_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      is_read boolean NOT NULL DEFAULT false
    );
    CREATE INDEX ON message_reply (lead_id, received_at DESC);
    CREATE INDEX ON message_reply (routed_to_user_id, is_read);

    -- Compliance
    CREATE TABLE suppression_list (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      channel text NOT NULL,                     -- email | sms | whatsapp
      address text NOT NULL,
      reason text NOT NULL,                      -- unsubscribe | hard_bounce | stop_keyword | complaint | manual
      source text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX suppression_list_channel_addr ON suppression_list (channel, lower(address));

    CREATE TABLE optin_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      channel text NOT NULL,
      optin_source text,                         -- form | import | api | verbal
      opted_in_at timestamptz NOT NULL DEFAULT now(),
      opted_out_at timestamptz
    );
    CREATE INDEX ON optin_log (lead_id, channel);

    -- WhatsApp: numbers, quotas, credits
    CREATE TABLE whatsapp_numbers (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      phone text NOT NULL,
      display_name text,
      wabridge_phone_number_id text,
      is_default boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      UNIQUE (phone)
    );

    CREATE TABLE whatsapp_quota (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      whatsapp_number_id uuid REFERENCES whatsapp_numbers(id) ON DELETE CASCADE,
      monthly_business_limit integer,
      monthly_business_used integer NOT NULL DEFAULT 0,
      daily_business_limit integer,
      daily_business_used integer NOT NULL DEFAULT 0,
      monthly_session_limit integer,
      monthly_session_used integer NOT NULL DEFAULT 0,
      daily_session_limit integer,
      daily_session_used integer NOT NULL DEFAULT 0,
      reset_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE subscription_credits (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      credit_type text NOT NULL UNIQUE,          -- email | sms | whatsapp_business | whatsapp_session
      balance numeric(14,2) NOT NULL DEFAULT 0,
      monthly_allocation numeric(14,2) NOT NULL DEFAULT 0,
      last_recharge_at timestamptz,
      expires_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE credit_transactions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      credit_type text NOT NULL,
      amount numeric(14,2) NOT NULL,
      reason text NOT NULL,
      ref_type text,
      ref_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON credit_transactions (credit_type, created_at DESC);

    -- Scheduled one-off sends
    CREATE TABLE scheduled_sends (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE SET NULL,
      channel text NOT NULL,                     -- email | sms | whatsapp
      template_id uuid NOT NULL,
      lead_ids uuid[] NOT NULL,
      variable_overrides_json jsonb,
      scheduled_for timestamptz NOT NULL,
      respects_business_hours boolean NOT NULL DEFAULT true,
      status text NOT NULL DEFAULT 'scheduled',  -- scheduled | running | completed | cancelled | failed
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON scheduled_sends (scheduled_for) WHERE status = 'scheduled';
    CREATE INDEX ON scheduled_sends (user_id, created_at DESC);
    CREATE TRIGGER trg_scheduled_sends_updated_at BEFORE UPDATE ON scheduled_sends FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  // Seed the template variable registry
  pgm.sql(`
    INSERT INTO template_variables (key, label, example, resolver_function, scope) VALUES
    ('Lead.FullName', 'Lead Full Name', 'Rahul Sharma', 'leadFullName', ARRAY['email','sms','whatsapp']),
    ('Lead.FirstName', 'Lead First Name', 'Rahul', 'leadFirstName', ARRAY['email','sms','whatsapp']),
    ('Lead.Email', 'Lead Email', 'rahul@example.com', 'leadEmail', ARRAY['email']),
    ('Lead.Phone', 'Lead Phone', '+919999999999', 'leadPhone', ARRAY['sms','whatsapp']),
    ('Lead.WhatsApp', 'Lead WhatsApp', '+919999999999', 'leadWhatsApp', ARRAY['whatsapp']),
    ('Lead.Program', 'Program Name', 'Data Science', 'leadProgram', ARRAY['email','sms','whatsapp']),
    ('Lead.Stage', 'Current Stage', 'Interested', 'leadStage', ARRAY['email','sms','whatsapp']),
    ('Counsellor.Name', 'Counsellor Name', 'Priya', 'counsellorName', ARRAY['email','sms','whatsapp']),
    ('Counsellor.Email', 'Counsellor Email', 'priya@institute.in', 'counsellorEmail', ARRAY['email']),
    ('Counsellor.Phone', 'Counsellor Phone', '+918888888888', 'counsellorPhone', ARRAY['email','sms']),
    ('Tenant.Name', 'Tenant Name', 'Speedup Institute', 'tenantName', ARRAY['email','sms','whatsapp']),
    ('Tenant.CompanyName', 'Company Name', 'Speedup Innovation Pvt Ltd', 'tenantCompanyName', ARRAY['email','sms','whatsapp']),
    ('Tenant.LogoUrl', 'Tenant Logo URL', 'https://cdn.../logo.png', 'tenantLogoUrl', ARRAY['email']),
    ('Tenant.Website', 'Tenant Website', 'https://speedup.in', 'tenantWebsite', ARRAY['email']),
    ('Program.Name', 'Program Name', 'MBA', 'programName', ARRAY['email','sms','whatsapp']),
    ('Program.Price', 'Program Price', '125000', 'programPrice', ARRAY['email','whatsapp'])
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS scheduled_sends;
    DROP TABLE IF EXISTS credit_transactions;
    DROP TABLE IF EXISTS subscription_credits;
    DROP TABLE IF EXISTS whatsapp_quota;
    DROP TABLE IF EXISTS whatsapp_numbers;
    DROP TABLE IF EXISTS optin_log;
    DROP TABLE IF EXISTS suppression_list;
    DROP TABLE IF EXISTS message_reply;
    DROP TABLE IF EXISTS message_log;
    DROP TABLE IF EXISTS template_variables;
    DROP TABLE IF EXISTS whatsapp_templates;
    DROP TABLE IF EXISTS sms_templates;
    DROP TABLE IF EXISTS email_templates;
  `);
};
