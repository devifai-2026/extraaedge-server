/* eslint-disable camelcase */
// Call recordings captured on a user's device (the Android call-recorder app)
// and uploaded in the background. Unlike `lead_call_recordings` (which is
// strictly lead-scoped, NOT NULL lead_id, ON DELETE CASCADE), a device
// recording may arrive BEFORE we know which lead it belongs to — the server
// matches the phone number to a lead on upload, but a no-match still gets
// stored for later review. Hence lead_id is nullable here.
//
// The audio itself lives in GCS (object storage); this row only holds the
// pointer (`r2_key`) + metadata, matching every other `*_r2_key` column.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE device_recordings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      -- Null when the phone number matched no live lead (or matched >1).
      lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
      phone_raw text NOT NULL,               -- exactly what the device sent
      phone_digits text,                     -- last-10 normalized (audit + review filter)
      -- matched   : exactly one live lead matched the number.
      -- unmatched : no live lead matched (or the number was < 10 digits).
      -- ambiguous : >1 live lead matched — we refuse to guess.
      match_status text NOT NULL
        CHECK (match_status IN ('matched', 'unmatched', 'ambiguous')),
      r2_key text NOT NULL,                  -- GCS object key
      file_name text,
      size_bytes bigint,
      duration_seconds integer,
      content_type text,
      device_id text,                        -- optional, from X-Device-Id header
      -- Client-supplied idempotency key (device_id + original file identity).
      -- Lets the device's retrying background job re-POST safely: a repeat
      -- returns the existing row instead of storing a duplicate.
      client_ref text,
      uploaded_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON device_recordings (lead_id) WHERE deleted_at IS NULL;
    CREATE INDEX ON device_recordings (phone_digits);
    CREATE INDEX ON device_recordings (match_status) WHERE deleted_at IS NULL;
    -- One row per client_ref (idempotency). Partial so multiple NULLs are fine.
    CREATE UNIQUE INDEX device_recordings_client_ref_uniq
      ON device_recordings (client_ref) WHERE client_ref IS NOT NULL;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS device_recordings;`);
};
