/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('plans', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true, unique: true },
    description: { type: 'text' },
    price_monthly: { type: 'numeric(10,2)' },
    currency: { type: 'text', default: 'INR' },
    features_json: { type: 'jsonb', default: '{}' },
    included_email_credits: { type: 'integer', default: 0 },
    included_sms_credits: { type: 'integer', default: 0 },
    included_whatsapp_credits: { type: 'integer', default: 0 },
    max_users: { type: 'integer' },
    max_leads: { type: 'integer' },
    is_public: { type: 'boolean', default: true },
    created_at: { type: 'timestamptz', default: pgm.func('now()'), notNull: true },
    updated_at: { type: 'timestamptz', default: pgm.func('now()'), notNull: true },
    deleted_at: { type: 'timestamptz' },
  });

  pgm.addConstraint('tenants', 'fk_tenants_plan', {
    foreignKeys: { columns: 'plan_id', references: 'plans(id)' },
  });

  pgm.sql(`CREATE TRIGGER trg_plans_updated_at BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();`);
};

exports.down = (pgm) => {
  pgm.sql('DROP TRIGGER IF EXISTS trg_plans_updated_at ON plans;');
  pgm.dropConstraint('tenants', 'fk_tenants_plan');
  pgm.dropTable('plans');
};
