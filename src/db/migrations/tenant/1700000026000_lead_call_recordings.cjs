// Manually-uploaded call recordings attached to a lead.
//
// Distinct from the existing `calls` table — that one represents Exotel /
// telephony events with rich call metadata (duration, disposition, status,
// recording_r2_key generated automatically from a webhook). This table is
// for the case where a counsellor records a call on their phone and uploads
// the .mp3 manually from the lead-edit drawer.
//
// stage / sub-stage are snapshotted from the lead at upload time so the
// "calls during Contacted stage" view stays correct even if the lead later
// moves through more stages.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE lead_call_recordings (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      stage_id uuid REFERENCES lead_stages(id) ON DELETE SET NULL,
      sub_stage_id uuid REFERENCES lead_sub_stages(id) ON DELETE SET NULL,
      r2_key text NOT NULL,
      file_name text,
      size_bytes bigint,
      duration_seconds integer,
      notes text,
      uploaded_by uuid REFERENCES users(id) ON DELETE SET NULL,
      uploaded_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON lead_call_recordings (lead_id, uploaded_at DESC);
    CREATE INDEX ON lead_call_recordings (stage_id);
    CREATE INDEX ON lead_call_recordings (uploaded_by);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS lead_call_recordings;`);
};
