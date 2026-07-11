/**
 * Recorder app config: folder path scanned by the counsellor Android app
 * and the local hour (0-23) at which the daily upload sync runs.
 */
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants
      ADD COLUMN recorder_folder_path text,
      ADD COLUMN recorder_sync_hour smallint NOT NULL DEFAULT 21
        CONSTRAINT tenants_recorder_sync_hour_ck CHECK (recorder_sync_hour BETWEEN 0 AND 23);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    ALTER TABLE tenants
      DROP COLUMN IF EXISTS recorder_folder_path,
      DROP COLUMN IF EXISTS recorder_sync_hour;
  `);
};
