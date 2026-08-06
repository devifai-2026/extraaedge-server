/* eslint-disable camelcase */
// Adds a location fix to each login/logout event so it can be plotted on a
// map. lat/lng/geo_city/geo_country are resolved offline from the IP at
// insert time (geoip-lite — no API key, no per-request cost); location_source
// distinguishes that IP-derived fix ('ip', city-level accuracy) from a
// precise one the browser later reported via the location gate ('gps',
// exact) — see middleware/requireClockIn-style LocationGate.jsx and
// POST /auth/location.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE user_login_events
      ADD COLUMN IF NOT EXISTS lat numeric(9,6),
      ADD COLUMN IF NOT EXISTS lng numeric(9,6),
      ADD COLUMN IF NOT EXISTS geo_city text,
      ADD COLUMN IF NOT EXISTS geo_country text,
      ADD COLUMN IF NOT EXISTS location_source text
        CHECK (location_source IN ('ip', 'gps'));
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE user_login_events
      DROP COLUMN IF EXISTS lat,
      DROP COLUMN IF EXISTS lng,
      DROP COLUMN IF EXISTS geo_city,
      DROP COLUMN IF EXISTS geo_country,
      DROP COLUMN IF EXISTS location_source;
  `);
};
