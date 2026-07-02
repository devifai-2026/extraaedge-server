/* eslint-disable camelcase */
// Multi-lead attachment for device recordings.
//
// Before: a recording matched at most ONE lead; >1 match was 'ambiguous' and
// left unattached. Now a recording attaches to ALL leads sharing the called
// number, flagged as a multi-match for review.
//
// - Relax the match_status CHECK: replace 'ambiguous' with 'multi'.
// - Add multi_match boolean flag (true when >1 lead matched).
// - New join table device_recording_leads (recording -> many leads). The
//   existing device_recordings.lead_id is kept as the "primary" lead (first
//   match) for backward-compatible single-lead reads; the join is the full set.
exports.up = (pgm) => {
  pgm.sql(`
    -- Any pre-existing 'ambiguous' rows become 'unmatched' (they were never
    -- attached anyway); then swap the CHECK to allow 'multi'.
    UPDATE device_recordings SET match_status = 'unmatched' WHERE match_status = 'ambiguous';
    ALTER TABLE device_recordings DROP CONSTRAINT IF EXISTS device_recordings_match_status_check;
    ALTER TABLE device_recordings
      ADD CONSTRAINT device_recordings_match_status_check
      CHECK (match_status IN ('matched', 'unmatched', 'multi'));

    ALTER TABLE device_recordings
      ADD COLUMN IF NOT EXISTS multi_match boolean NOT NULL DEFAULT false;

    CREATE TABLE IF NOT EXISTS device_recording_leads (
      recording_id uuid NOT NULL REFERENCES device_recordings(id) ON DELETE CASCADE,
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (recording_id, lead_id)
    );
    CREATE INDEX IF NOT EXISTS device_recording_leads_lead_idx ON device_recording_leads (lead_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS device_recording_leads;
    ALTER TABLE device_recordings DROP COLUMN IF EXISTS multi_match;
    ALTER TABLE device_recordings DROP CONSTRAINT IF EXISTS device_recordings_match_status_check;
    ALTER TABLE device_recordings
      ADD CONSTRAINT device_recordings_match_status_check
      CHECK (match_status IN ('matched', 'unmatched', 'ambiguous'));
  `);
};
