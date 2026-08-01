/* eslint-disable camelcase */
// Per-tenant OTP template id.
//
// Each institute sends through its OWN WABridge account (wa_settings), and a
// template id is only valid on the account that owns it — sending tenant A's
// template with tenant B's keys returns "You don't have enough permission to
// perform this action!". The login OTP therefore needs the id alongside the
// credentials, not a single global one.
//
// NULL means "fall back to env.WABRIDGE_TEMPLATE_OTP", so tenants that share
// the platform account keep working with no data change.
exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE wa_settings ADD COLUMN IF NOT EXISTS wabridge_template_otp text;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE wa_settings DROP COLUMN IF EXISTS wabridge_template_otp;
  `);
};
