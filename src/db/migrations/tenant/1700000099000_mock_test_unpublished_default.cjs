/* eslint-disable camelcase */
// Phase F6 — mock tests should go live only when the trainer publishes.
// Flip the column default from true to false so a newly-created test starts
// UNPUBLISHED (the create path doesn't set is_published). Existing rows keep
// their current value — this only changes the default for future inserts.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE mock_tests ALTER COLUMN is_published SET DEFAULT false;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE mock_tests ALTER COLUMN is_published SET DEFAULT true;`);
};
