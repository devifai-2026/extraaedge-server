/* eslint-disable camelcase */
// Per-tenant pilot switch for hard clock-in enforcement. Defaults OFF so
// shipping the feature doesn't immediately lock out every existing tenant's
// staff — flip it on tenant-by-tenant (same shape as ip_allowlist/require_2fa)
// once a branch has been piloted.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('tenants', {
    clock_in_enforced: { type: 'boolean', notNull: true, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('tenants', 'clock_in_enforced');
};
