/* eslint-disable camelcase */

// Audit trail for the branch manager's "view as" — looking at a staff
// member's screens read-only.
//
// WHY A TENANT TABLE AND NOT impersonation_sessions: that table is in the
// SYSTEM database and its platform_user_id is NOT NULL with an FK to
// platform_users. A branch manager is a tenant user with no platform_users
// row, so it cannot hold these sessions. The two also answer different
// questions — "which Anthropic-side operator entered this tenant" vs "which
// of our managers looked at our staff" — and the second belongs to the tenant
// that owns the people in it.
//
// Both ids are plain uuid with FKs into this tenant's users table, so a
// session cannot name someone outside the tenant.

exports.up = (pgm) => {
  pgm.createTable('view_as_sessions', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    // The branch manager doing the looking. ON DELETE CASCADE: if the manager
    // is hard-deleted the sessions go with them.
    actor_user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    // The staff member being looked at.
    target_user_id: { type: 'uuid', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    // Denormalised so the row still says WHO was viewed after the user row is
    // renamed or soft-deleted — an audit trail that resolves to a dangling id
    // is not an audit trail.
    target_user_email: { type: 'citext' },
    // notNull, and the schema requires min(5): a look at someone's screens is
    // recorded with a stated purpose or it does not happen.
    reason: { type: 'text', notNull: true },
    started_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    // NULL while the session is open. Set by /view-as/stop, and left NULL if
    // the manager simply lets the 30-minute token expire.
    ended_at: { type: 'timestamptz' },
    ip: { type: 'text' },
    user_agent: { type: 'text' },
  });

  // "What has this manager been looking at lately" — the list default order.
  pgm.createIndex('view_as_sessions', ['actor_user_id', 'started_at']);
  // "Who has been looking at THIS person" — the question a staff member or an
  // auditor actually asks.
  pgm.createIndex('view_as_sessions', ['target_user_id', 'started_at']);
};

exports.down = (pgm) => {
  pgm.dropTable('view_as_sessions');
};
