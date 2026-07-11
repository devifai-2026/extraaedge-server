/* eslint-disable camelcase */
// Track whether the "class starting soon" reminder has fired for a class, so
// the reminder worker sends it once (not every tick).
exports.shorthands = undefined;
exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE classes ADD COLUMN IF NOT EXISTS reminder_sent_at timestamptz;`);
};
exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE classes DROP COLUMN IF EXISTS reminder_sent_at;`);
};
