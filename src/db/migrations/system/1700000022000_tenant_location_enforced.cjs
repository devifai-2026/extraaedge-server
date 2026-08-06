/* eslint-disable camelcase */
// Per-tenant pilot switch for the hard browser-location gate, independent of
// clock_in_enforced (a tenant may want one without the other). Defaults OFF
// for the same reason clock_in_enforced does — see 1700000021000.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('tenants', {
    location_enforced: { type: 'boolean', notNull: true, default: false },
  });
};

exports.down = (pgm) => {
  pgm.dropColumn('tenants', 'location_enforced');
};
