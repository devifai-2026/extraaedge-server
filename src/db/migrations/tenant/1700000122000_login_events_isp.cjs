/* eslint-disable camelcase */
// ISP/organization name for each login event — ip-api.com provides this
// (geoip-lite never could, it has no ISP data at all). Requested alongside
// the switch from geoip-lite to ip-api.com for better location accuracy.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE user_login_events
      ADD COLUMN IF NOT EXISTS geo_isp text;
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`
    ALTER TABLE user_login_events
      DROP COLUMN IF EXISTS geo_isp;
  `);
};
