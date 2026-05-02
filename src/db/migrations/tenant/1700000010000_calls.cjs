/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE call_dispositions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code text NOT NULL UNIQUE,
      label text NOT NULL,
      category text NOT NULL,                    -- positive | neutral | negative
      requires_callback boolean NOT NULL DEFAULT false,
      auto_create_followup_hours integer,
      is_active boolean NOT NULL DEFAULT true,
      order_index integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );

    CREATE TABLE calls (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      direction text NOT NULL DEFAULT 'outbound', -- outbound | inbound
      status text NOT NULL DEFAULT 'queued',      -- queued | ringing | answered | completed | missed | no_answer | failed
      duration_seconds integer,
      recording_r2_key text,
      recording_duration_seconds integer,
      recording_stored_at timestamptz,
      recording_size_bytes bigint,
      provider text NOT NULL DEFAULT 'exotel',
      provider_call_id text,
      remarks text,
      disposition_code text REFERENCES call_dispositions(code),
      disposition_category text,
      callback_requested_at timestamptz,
      scheduled_for timestamptz,
      started_at timestamptz,
      ended_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON calls (lead_id, started_at DESC);
    CREATE INDEX ON calls (user_id, started_at DESC);
    CREATE INDEX ON calls (disposition_code);
    CREATE INDEX ON calls (provider_call_id);
    CREATE INDEX ON calls (status);
    CREATE TRIGGER trg_calls_updated_at BEFORE UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS calls;
    DROP TABLE IF EXISTS call_dispositions;
  `);
};
