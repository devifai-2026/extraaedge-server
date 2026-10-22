/* eslint-disable camelcase */
// Per-tenant login mode, replacing the PASSWORD_LOGIN_SLUGS env var.
//
// WHY THIS MOVES OUT OF ENV: which tenants may use a password was a
// comma-separated list in the API's environment (see auth/service.js
// passwordLoginSlugs). That makes a per-customer setting an operational one —
// changing it meant editing env and redeploying the API, it could not be
// surfaced in the product-owner console at all, and the value was invisible to
// anyone reading the tenant row. A column makes it data: readable, auditable,
// and changeable per tenant without a deploy.
//
// VALUES:
//   'otp'      — OTP only. The login screen offers no password box and the
//                server refuses password logins for this tenant.
//   'password' — password only. No OTP is offered.
//   'both'     — offer both (what the demo tenant effectively had).
//
// DEFAULT 'both' is deliberate and is the safe migration, NOT a security
// loosening: today every tenant already accepts a password whenever
// OTP_LOGIN_ENFORCED is off, which is the current production state. Defaulting
// to 'otp' here would instantly lock out every existing tenant whose users
// sign in with a password. auth/service.js keeps honouring OTP_LOGIN_ENFORCED
// on top of this column, so the env var can still clamp things globally until
// each tenant's mode has been set deliberately.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.addColumn('tenants', {
    auth_mode: { type: 'text', notNull: true, default: 'both' },
  });
  pgm.addConstraint('tenants', 'tenants_auth_mode_chk',
    "CHECK (auth_mode IN ('otp', 'password', 'both'))");
};

exports.down = (pgm) => {
  pgm.dropConstraint('tenants', 'tenants_auth_mode_chk');
  pgm.dropColumn('tenants', 'auth_mode');
};
