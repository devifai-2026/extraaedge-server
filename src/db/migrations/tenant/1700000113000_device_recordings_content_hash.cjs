/* eslint-disable camelcase */
// Content-hash dedup for device recordings.
//
// The Android app now scans the WHOLE device for audio files instead of one
// configured folder, so the same recording can reach /confirm more than once:
// a copy of the file in a second folder, a re-scan after the device-side
// ledger is lost (reinstall / re-login), or a second phone holding the same
// files. client_ref (sha256 of name:size) only catches the same file identity;
// content_hash (sha256 of the file BYTES, computed on the device) catches the
// same audio regardless of where it lives or what it has been renamed to.
//
// The unique index deliberately does NOT filter on deleted_at: once a manager
// deletes a recording, re-uploading the same bytes must not resurrect it —
// the confirm endpoint acknowledges the duplicate without inserting.
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE device_recordings ADD COLUMN IF NOT EXISTS content_hash text;
    CREATE UNIQUE INDEX IF NOT EXISTS device_recordings_content_hash_uniq
      ON device_recordings (content_hash) WHERE content_hash IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP INDEX IF EXISTS device_recordings_content_hash_uniq;
    ALTER TABLE device_recordings DROP COLUMN IF EXISTS content_hash;
  `);
};
