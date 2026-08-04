/* eslint-disable camelcase */
// Registry of the phones running the call-recorder APK.
//
// Until now a device left only a trace: device_recordings.device_id, an
// optional header on an upload. That is useless for the question the product
// owner actually asks — "the recordings aren't coming in, whose phone is it
// and what's wrong with it?" — because a phone that has stopped uploading
// stops producing rows entirely, so the evidence disappears exactly when you
// need it.
//
// This table is the opposite: the device reports in on a heartbeat whether or
// not it has anything to upload, so silence becomes visible (last_seen_at
// going stale) and the usual causes become inspectable (a permission revoked,
// battery optimisation switched back on, an old app version).
//
// It also carries the remote "upload everything now" command. There is no
// push channel to these phones (no Firebase), so the flow is pull: the PO
// stamps sync_requested_at, the device notices on its next heartbeat, runs
// the sync it already has, and stamps the outcome back. Every stage is a
// column so the console can show "requested → picked up → finished" rather
// than a button that appears to do nothing for fifteen minutes.
//
// One row per (device, user). A reinstall generates a fresh install id and so
// appears as a new device — correct, because a reinstall resets the very
// permission grants this table exists to track; the old row simply goes stale.

exports.shorthands = undefined;

exports.up = async (pgm) => {
  await pgm.db.query(`
    CREATE TABLE IF NOT EXISTS recorder_devices (
      id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Stable per-install UUID minted by the app on first run. NOT a
      -- hardware id: ANDROID_ID needs no permission but is inconsistent
      -- across OEMs and vendor resets, and anything stronger is a privacy
      -- problem we don't need for "which phone is this".
      device_id     text NOT NULL,
      user_id       uuid REFERENCES users(id) ON DELETE CASCADE,

      -- Identity, for recognising the phone in a list.
      manufacturer  text,
      model         text,
      os_version    text,
      app_version   text,

      -- Runtime permission state, reported by the app on every heartbeat.
      -- jsonb rather than columns: the set changes with Android versions and
      -- with what the app asks for, and a new key must not need a migration.
      -- Shape: { all_files: bool, notifications: bool,
      --          battery_unrestricted: bool, read_storage: bool }
      permissions   jsonb NOT NULL DEFAULT '{}'::jsonb,

      -- Heartbeat. A stale last_seen_at is the primary signal that something
      -- is wrong, so it is indexed for the console's ordering.
      last_seen_at  timestamptz,
      first_seen_at timestamptz NOT NULL DEFAULT now(),

      -- Remote "upload everything now", as a request/ack pair.
      sync_requested_at   timestamptz,
      sync_requested_by   uuid,           -- platform user id; no FK, they live in the SYSTEM db
      sync_started_at     timestamptz,
      sync_completed_at   timestamptz,
      sync_result         jsonb,          -- { uploaded, unmatched, failed, scanned }

      created_at    timestamptz NOT NULL DEFAULT now(),
      updated_at    timestamptz NOT NULL DEFAULT now()
    );

    -- One row per install. The heartbeat upserts on this.
    CREATE UNIQUE INDEX IF NOT EXISTS recorder_devices_device_id_uq
      ON recorder_devices (device_id);
    CREATE INDEX IF NOT EXISTS recorder_devices_user_idx
      ON recorder_devices (user_id);
    -- The console lists most-recently-seen first.
    CREATE INDEX IF NOT EXISTS recorder_devices_last_seen_idx
      ON recorder_devices (last_seen_at DESC NULLS LAST);
    -- Finding devices with an unacknowledged pull request.
    CREATE INDEX IF NOT EXISTS recorder_devices_pending_sync_idx
      ON recorder_devices (sync_requested_at)
      WHERE sync_requested_at IS NOT NULL AND sync_completed_at IS NULL;

    DROP TRIGGER IF EXISTS trg_recorder_devices_updated_at ON recorder_devices;
    CREATE TRIGGER trg_recorder_devices_updated_at
      BEFORE UPDATE ON recorder_devices
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = async (pgm) => {
  await pgm.db.query(`DROP TABLE IF EXISTS recorder_devices;`);
};
