/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`
    -- Payments
    CREATE TABLE payment_links (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      amount numeric(12,2) NOT NULL,
      currency text NOT NULL DEFAULT 'INR',
      provider text NOT NULL DEFAULT 'razorpay',
      provider_link_id text,
      short_url text,
      description text,
      status text NOT NULL DEFAULT 'created',    -- created | paid | expired | cancelled
      expires_at timestamptz,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON payment_links (lead_id, created_at DESC);
    CREATE INDEX ON payment_links (provider_link_id);
    CREATE TRIGGER trg_payment_links_updated_at BEFORE UPDATE ON payment_links FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE payments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      payment_link_id uuid REFERENCES payment_links(id) ON DELETE SET NULL,
      amount numeric(12,2) NOT NULL,
      currency text NOT NULL DEFAULT 'INR',
      provider text NOT NULL DEFAULT 'razorpay',
      provider_payment_id text UNIQUE,
      status text NOT NULL,                      -- captured | failed | refunded | pending
      method text,                               -- card | upi | netbanking
      paid_at timestamptz,
      refunded_at timestamptz,
      raw_webhook_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON payments (lead_id, paid_at DESC);
    CREATE INDEX ON payments (status);

    CREATE TABLE payment_webhook_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      provider text NOT NULL,
      event_type text NOT NULL,
      signature text,
      body_json jsonb NOT NULL,
      processed_at timestamptz,
      error text,
      received_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON payment_webhook_log (provider, received_at DESC);

    CREATE TABLE payment_attributions (
      payment_id uuid PRIMARY KEY REFERENCES payments(id) ON DELETE CASCADE,
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      first_touch_campaign_id uuid,
      first_touch_channel text,
      first_touch_source text,
      first_touch_at timestamptz,
      last_touch_campaign_id uuid,
      last_touch_channel text,
      last_touch_source text,
      last_touch_at timestamptz,
      amount_attributed_first numeric(12,2),
      amount_attributed_last numeric(12,2),
      linear_distribution_json jsonb,
      attribution_model text NOT NULL DEFAULT '50_50',
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON payment_attributions (lead_id);
    CREATE INDEX ON payment_attributions (first_touch_campaign_id);
    CREATE INDEX ON payment_attributions (last_touch_campaign_id);

    -- Referrals
    CREATE TABLE lead_referral_codes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      code text NOT NULL UNIQUE,
      landing_url text,
      uses_count integer NOT NULL DEFAULT 0,
      max_uses integer,
      expires_at timestamptz,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON lead_referral_codes (lead_id) WHERE deleted_at IS NULL;
    CREATE INDEX ON lead_referral_codes (code) WHERE is_active AND deleted_at IS NULL;

    CREATE TABLE referral_policies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      trigger text NOT NULL,                     -- lead_created | payment_succeeded | enrolled
      credit_type text NOT NULL,                 -- points | cash | discount | custom
      credit_amount numeric(12,2) NOT NULL,
      credit_currency text,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE TRIGGER trg_referral_policies_updated_at BEFORE UPDATE ON referral_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE referral_credits (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      referrer_lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      referred_lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      policy_id uuid REFERENCES referral_policies(id) ON DELETE SET NULL,
      trigger_event text NOT NULL,
      credit_type text NOT NULL,
      credit_amount numeric(12,2) NOT NULL,
      status text NOT NULL DEFAULT 'pending',    -- pending | credited | revoked
      triggered_at timestamptz NOT NULL DEFAULT now(),
      credited_at timestamptz,
      revoked_at timestamptz,
      revoked_reason text
    );
    CREATE INDEX ON referral_credits (referrer_lead_id, status);
    CREATE INDEX ON referral_credits (referred_lead_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS referral_credits;
    DROP TABLE IF EXISTS referral_policies;
    DROP TABLE IF EXISTS lead_referral_codes;
    DROP TABLE IF EXISTS payment_attributions;
    DROP TABLE IF EXISTS payment_webhook_log;
    DROP TABLE IF EXISTS payments;
    DROP TABLE IF EXISTS payment_links;
  `);
};
