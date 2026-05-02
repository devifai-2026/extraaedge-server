/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('platform_users', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    name: { type: 'text', notNull: true },
    email: { type: 'citext', notNull: true, unique: true },
    phone: { type: 'text' },
    password_hash: { type: 'text', notNull: true },
    role: { type: 'text', notNull: true }, // product_owner | support_admin
    is_active: { type: 'boolean', notNull: true, default: true },
    totp_secret: { type: 'text' }, // optional 2FA
    last_login_at: { type: 'timestamptz' },
    created_at: { type: 'timestamptz', default: pgm.func('now()'), notNull: true },
    updated_at: { type: 'timestamptz', default: pgm.func('now()'), notNull: true },
    deleted_at: { type: 'timestamptz' },
  });

  // Exactly one active product_owner allowed.
  pgm.sql(`
    CREATE UNIQUE INDEX one_active_product_owner
      ON platform_users ((1))
      WHERE role = 'product_owner' AND deleted_at IS NULL AND is_active = true;
  `);

  pgm.createTable('platform_user_sessions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    platform_user_id: { type: 'uuid', notNull: true, references: 'platform_users(id)', onDelete: 'CASCADE' },
    refresh_token_hash: { type: 'text', notNull: true, unique: true },
    last_activity_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    issued_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    ip: { type: 'text' },
    user_agent: { type: 'text' },
  });
  pgm.createIndex('platform_user_sessions', 'platform_user_id');

  pgm.sql(`CREATE TRIGGER trg_platform_users_updated_at BEFORE UPDATE ON platform_users FOR EACH ROW EXECUTE FUNCTION set_updated_at();`);
};

exports.down = (pgm) => {
  pgm.dropTable('platform_user_sessions');
  pgm.sql('DROP INDEX IF EXISTS one_active_product_owner;');
  pgm.sql('DROP TRIGGER IF EXISTS trg_platform_users_updated_at ON platform_users;');
  pgm.dropTable('platform_users');
};
