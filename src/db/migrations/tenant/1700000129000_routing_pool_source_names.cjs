/* eslint-disable camelcase */
// Let a routing pool claim leads by the tenant's OWN source / channel names,
// not just the five built-in acquisition channels.
//
// Why: LEAD_ORIGINS (whatsapp | instagram | facebook | justdial | website) is
// derived by pattern-matching first_touch_channel / first_touch_source, which
// covers the channels the product integrates with directly. It does NOT cover
// a tenant's own marketing vocabulary. The concrete case this exists for is
// "Social Leads": on the largest tenant, 1,202 live leads carry
// channel='Online', source='Social Media' and classify to NO origin at all, so
// no pool could ever route them.
//
// `source_names` is matched case-insensitively against BOTH
// first_touch_source and first_touch_channel, so an admin can type either the
// source ("Social Media") or the channel ("Online") — whichever their data
// actually uses — and it works.
//
// A pool now needs at least one of `origins` or `source_names`; both may be
// set, in which case either one matching claims the lead.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE lead_routing_pools
      ADD COLUMN IF NOT EXISTS source_names text[] NOT NULL DEFAULT '{}';

    -- Membership lookup for the resolver's second matching path.
    CREATE INDEX IF NOT EXISTS lead_routing_pools_source_names_idx
      ON lead_routing_pools USING gin (source_names);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS lead_routing_pools_source_names_idx;
    ALTER TABLE lead_routing_pools DROP COLUMN IF EXISTS source_names;
  `);
};
