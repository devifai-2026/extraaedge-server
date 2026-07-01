/* eslint-disable camelcase */
// Platform-wide directory of user phone numbers.
//
// Each tenant is its own database, so a normal UNIQUE index can't guarantee a
// phone number is unique ACROSS tenants. This system-DB table is the single
// place every tenant's user phones are registered, giving us that global
// guarantee: phone_digits (last-10 normalized) is the primary key, so a number
// can belong to exactly one (tenant, user) at a time.
//
// It also lets the device-recording upload path resolve a counsellor's phone
// -> tenant + user without fanning out a query to every tenant DB.
//
// Rollout is SOFT first: the app-layer claim runs in log-only mode until
// existing cross-tenant duplicates are cleaned up (see scripts/backfill-user-
// phones.js), then enforcement flips on. The PK still physically prevents
// duplicate INSERTs; log-only mode just means the claim helper swallows the
// conflict instead of surfacing a 409 to the admin.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE user_phone_directory (
      phone_digits text PRIMARY KEY,        -- last-10 normalized (lib/phone.last10Digits)
      tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      user_id uuid NOT NULL,                -- users.id within that tenant DB (no cross-db FK)
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON user_phone_directory (tenant_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS user_phone_directory;`);
};
