/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.createTable('impersonation_sessions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    platform_user_id: { type: 'uuid', notNull: true, references: 'platform_users(id)', onDelete: 'CASCADE' },
    tenant_id: { type: 'uuid', notNull: true, references: 'tenants(id)', onDelete: 'CASCADE' },
    tenant_user_id: { type: 'uuid', notNull: true },
    tenant_user_email: { type: 'citext' },
    reason: { type: 'text', notNull: true },
    read_only: { type: 'boolean', notNull: true, default: true },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    ended_at: { type: 'timestamptz' },
    ip: { type: 'text' },
    user_agent: { type: 'text' },
  });
  pgm.createIndex('impersonation_sessions', ['platform_user_id', 'started_at']);
  pgm.createIndex('impersonation_sessions', ['tenant_id', 'tenant_user_id']);

  pgm.createTable('platform_audit_log', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    platform_user_id: { type: 'uuid', references: 'platform_users(id)' },
    action: { type: 'text', notNull: true },
    entity_type: { type: 'text' },
    entity_id: { type: 'uuid' },
    tenant_id: { type: 'uuid', references: 'tenants(id)' },
    before_json: { type: 'jsonb' },
    after_json: { type: 'jsonb' },
    ip: { type: 'text' },
    user_agent: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
  pgm.createIndex('platform_audit_log', ['platform_user_id', 'created_at']);
  pgm.createIndex('platform_audit_log', ['tenant_id', 'created_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('platform_audit_log');
  pgm.dropTable('impersonation_sessions');
};
