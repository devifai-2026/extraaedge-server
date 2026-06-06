/* eslint-disable camelcase */
// Full cross-tenant API activity log for the product_owner "Danger Request
// Log". Every API request (after auth) is captured here: method, path, the
// acting account email, tenant, status, duration, and the FULL request +
// response bodies (with secrets redacted by the capture middleware). Lives in
// the SYSTEM db so a product_owner can query across all tenants at once.
exports.up = (pgm) => {
  pgm.createTable('platform_request_log', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },

    // Correlation with app logs / X-Request-Id header.
    request_id: { type: 'text' },

    // Who made the request. We denormalise the email/role so the log is
    // readable even after a user is deleted, and so it can capture tenant
    // users (not just platform users) — actor_user_id is therefore NOT a FK.
    actor_user_id: { type: 'uuid' },
    actor_email: { type: 'citext' },
    actor_role: { type: 'text' },           // tenant role or platform role
    is_platform_actor: { type: 'boolean', notNull: true, default: false },

    // Which tenant the request was scoped to (null for platform/global routes).
    tenant_id: { type: 'uuid', references: 'tenants(id)', onDelete: 'SET NULL' },
    tenant_slug: { type: 'text' },

    // HTTP envelope.
    method: { type: 'text', notNull: true },
    path: { type: 'text', notNull: true },
    route: { type: 'text' },                 // matched express route pattern, e.g. /leads/:id
    query_json: { type: 'jsonb' },
    status_code: { type: 'integer' },
    duration_ms: { type: 'integer' },

    // FULL payloads (redacted). Stored as jsonb when the body parsed as JSON,
    // else as text in *_text. Capture middleware caps size to avoid bloat.
    request_body: { type: 'jsonb' },
    response_body: { type: 'jsonb' },
    request_body_text: { type: 'text' },
    response_body_text: { type: 'text' },
    body_truncated: { type: 'boolean', notNull: true, default: false },

    // Error surface — populated for non-2xx so failed bulk uploads etc. are
    // trivially filterable.
    is_error: { type: 'boolean', notNull: true, default: false },
    error_code: { type: 'text' },
    error_message: { type: 'text' },

    // Coarse classification so the UI can highlight high-signal events.
    // e.g. 'bulk_import' | 'lead_create' | 'lead_reassign' | 'followup' | 'auth' | 'other'
    category: { type: 'text' },

    // Network context.
    ip: { type: 'text' },
    user_agent: { type: 'text' },

    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('platform_request_log', ['created_at']);
  pgm.createIndex('platform_request_log', ['tenant_id', 'created_at']);
  pgm.createIndex('platform_request_log', ['actor_email', 'created_at']);
  pgm.createIndex('platform_request_log', ['status_code']);
  pgm.createIndex('platform_request_log', ['is_error', 'created_at']);
  pgm.createIndex('platform_request_log', ['category', 'created_at']);
  pgm.createIndex('platform_request_log', ['method']);
  pgm.createIndex('platform_request_log', ['request_id']);
};

exports.down = (pgm) => {
  pgm.dropTable('platform_request_log');
};
