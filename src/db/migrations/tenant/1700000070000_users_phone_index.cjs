/* eslint-disable camelcase */
// Index users.phone on its normalized last-10-digits so resolving a
// counsellor by phone (device-recording uploads, and the phone-directory
// backfill/lookup) is index-backed rather than a full table scan. Mirrors the
// expression used for leads (leads_unique_phone_digits) and by lib/phone.
//
// NOTE: not UNIQUE here — platform-wide uniqueness is enforced in the system DB
// (user_phone_directory), and existing data may still contain duplicates during
// the soft-rollout window.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS users_phone_digits_idx
      ON users ((right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10)))
      WHERE deleted_at IS NULL
        AND length(right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 10)) = 10;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS users_phone_digits_idx;`);
};
