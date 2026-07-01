/* eslint-disable camelcase */
// Add uploader identity to device_recordings. The Android app now sends the
// counsellor's own phone number on confirm; the server resolves it to a user
// in this tenant and stamps uploaded_by, so a counsellor can see only their
// own uploads in the "Unmatched Recordings" review tab.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE device_recordings
      ADD COLUMN IF NOT EXISTS uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS counsellor_phone text;
    CREATE INDEX IF NOT EXISTS device_recordings_uploaded_by_idx
      ON device_recordings (uploaded_by) WHERE deleted_at IS NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS device_recordings_uploaded_by_idx;
    ALTER TABLE device_recordings
      DROP COLUMN IF EXISTS uploaded_by,
      DROP COLUMN IF EXISTS counsellor_phone;
  `);
};
