/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('tenants', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },

    // Identity
    name: { type: 'text', notNull: true },
    slug: { type: 'text', notNull: true, unique: true },

    // Branding (sidebar/header dynamic content — drives tenant-visible logo & colors)
    company_name: { type: 'text' },
    brand_name: { type: 'text' }, // Display name — shown in sidebar (replaces hardcoded "SPEEDUP INNOVATION")
    logo_url: { type: 'text' },
    logo_dark_url: { type: 'text' },
    favicon_url: { type: 'text' },
    brand_primary_color: { type: 'text', default: '#E53935' },
    brand_secondary_color: { type: 'text', default: '#C62828' },

    // Contact
    email: { type: 'citext' },
    phone: { type: 'text' },
    website: { type: 'text' },
    industry: { type: 'text' },

    // Address
    country: { type: 'text' },
    state: { type: 'text' },
    city: { type: 'text' },
    address_line1: { type: 'text' },
    address_line2: { type: 'text' },
    pincode: { type: 'text' },

    // Billing / subscription
    plan_id: { type: 'uuid' },
    billing_email: { type: 'citext' },
    status: { type: 'text', notNull: true, default: 'provisioning' }, // provisioning | active | suspended | cancelled
    trial_ends_at: { type: 'timestamptz' },
    subscription_ends_at: { type: 'timestamptz' },

    // Locale
    timezone: { type: 'text', notNull: true, default: 'Asia/Kolkata' },
    currency: { type: 'text', notNull: true, default: 'INR' },
    default_language: { type: 'text', notNull: true, default: 'en' },

    // DB connection info for this tenant — password encrypted (AES-256-GCM via lib/crypto.js)
    db_name: { type: 'text', notNull: true, unique: true },
    db_user: { type: 'text', notNull: true },
    db_password_encrypted: { type: 'text', notNull: true },

    // Security
    ip_allowlist: { type: 'text[]' }, // if non-empty, only these IPs may log in
    require_2fa: { type: 'boolean', default: false },

    // Meta
    provisioned_by_platform_user_id: { type: 'uuid' },
    created_at: { type: 'timestamptz', default: pgm.func('now()'), notNull: true },
    updated_at: { type: 'timestamptz', default: pgm.func('now()'), notNull: true },
    deleted_at: { type: 'timestamptz' },
  });

  pgm.createIndex('tenants', 'status');
  pgm.createIndex('tenants', 'deleted_at', { where: 'deleted_at IS NOT NULL' });
  pgm.sql(`CREATE TRIGGER trg_tenants_updated_at BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION set_updated_at();`);
};

exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_tenants_updated_at ON tenants;');
  pgm.dropTable('tenants');
};
