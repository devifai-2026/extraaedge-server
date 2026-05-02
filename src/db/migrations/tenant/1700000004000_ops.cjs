/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`
    -- Calendar
    CREATE TABLE business_hours (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      day_of_week integer NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      is_open boolean NOT NULL DEFAULT true,
      open_time time,
      close_time time,
      timezone text NOT NULL DEFAULT 'Asia/Kolkata',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX business_hours_day_unique ON business_hours (day_of_week);
    CREATE TRIGGER trg_business_hours_updated_at BEFORE UPDATE ON business_hours FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE holidays (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      date date NOT NULL UNIQUE,
      name text NOT NULL,
      is_full_day boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON holidays (date) WHERE deleted_at IS NULL;

    -- User availability (leave / training / meetings)
    CREATE TABLE user_availability (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      starts_at timestamptz NOT NULL,
      ends_at timestamptz NOT NULL,
      type text NOT NULL,                     -- leave | half_day | training | meeting | custom
      note text,
      is_recurring boolean NOT NULL DEFAULT false,
      recurrence_rule text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      CHECK (ends_at > starts_at)
    );
    CREATE INDEX ON user_availability (user_id, starts_at, ends_at) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_user_availability_updated_at BEFORE UPDATE ON user_availability FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Generic uploads
    CREATE TABLE uploaded_files (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      r2_key text NOT NULL UNIQUE,
      r2_bucket text NOT NULL,
      content_type text,
      size_bytes bigint,
      checksum_sha256 text,
      purpose text NOT NULL,                  -- avatar | brochure | note_attachment | ticket_attachment | template_asset | csv_import | export_result | recording | pdf_report
      ref_entity_type text,
      ref_entity_id uuid,
      visibility text NOT NULL DEFAULT 'private', -- private | tenant | public_signed
      uploaded_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON uploaded_files (ref_entity_type, ref_entity_id);
    CREATE INDEX ON uploaded_files (purpose);

    -- Bulk ingestion
    CREATE TABLE bulk_import_previews (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      file_r2_key text NOT NULL,
      field_mapping_json jsonb NOT NULL,
      defaults_json jsonb,
      total_rows integer NOT NULL DEFAULT 0,
      valid_rows integer NOT NULL DEFAULT 0,
      invalid_rows integer NOT NULL DEFAULT 0,
      duplicate_rows integer NOT NULL DEFAULT 0,
      sample_errors_json jsonb,
      duplicate_matches_json jsonb,
      expires_at timestamptz NOT NULL DEFAULT (now() + INTERVAL '24 hours'),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON bulk_import_previews (user_id, created_at DESC);

    CREATE TABLE bulk_imports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE SET NULL,
      preview_id uuid REFERENCES bulk_import_previews(id),
      source text NOT NULL DEFAULT 'csv',     -- csv | webhook | api
      file_r2_key text,
      file_name text,
      file_size bigint,
      field_mapping_json jsonb,
      defaults_json jsonb,
      total_rows integer NOT NULL DEFAULT 0,
      success_rows integer NOT NULL DEFAULT 0,
      failed_rows integer NOT NULL DEFAULT 0,
      duplicate_rows integer NOT NULL DEFAULT 0,
      duplicate_handling text NOT NULL DEFAULT 'skip',  -- skip | update_existing | create_new
      status text NOT NULL DEFAULT 'queued',  -- queued | processing | completed | failed
      send_welcome_email boolean NOT NULL DEFAULT false,
      send_welcome_sms boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      completed_at timestamptz
    );
    CREATE INDEX ON bulk_imports (user_id, created_at DESC);
    CREATE INDEX ON bulk_imports (status);

    CREATE TABLE bulk_import_failures (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      import_id uuid NOT NULL REFERENCES bulk_imports(id) ON DELETE CASCADE,
      row_number integer NOT NULL,
      raw_row_json jsonb,
      error_code text,
      error_message text,
      retried_at timestamptz,
      retry_import_id uuid REFERENCES bulk_imports(id)
    );
    CREATE INDEX ON bulk_import_failures (import_id);

    CREATE TABLE bulk_exports (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE SET NULL,
      filter_json jsonb,
      columns text[],
      cc_emails text[],
      bcc_emails text[],
      status text NOT NULL DEFAULT 'queued',  -- queued | processing | completed | failed
      file_r2_key text,
      row_count integer,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      completed_at timestamptz
    );
    CREATE INDEX ON bulk_exports (user_id, created_at DESC);

    -- Audit log
    CREATE TABLE audit_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      actor_type text NOT NULL DEFAULT 'tenant_user', -- tenant_user | platform_owner | system
      impersonated_by uuid,
      action text NOT NULL,
      entity_type text,
      entity_id uuid,
      before_json jsonb,
      after_json jsonb,
      ip text,
      user_agent text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON audit_log (user_id, created_at DESC);
    CREATE INDEX ON audit_log (entity_type, entity_id);
    CREATE INDEX ON audit_log (action, created_at DESC);

    -- Tickets
    CREATE TABLE tickets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      subject text NOT NULL,
      category text,
      priority text NOT NULL DEFAULT 'normal', -- low | normal | high | urgent
      description text,
      attachments jsonb,
      status text NOT NULL DEFAULT 'open',     -- open | in_progress | resolved | closed
      assigned_to_platform_user_id uuid,
      resolution_note text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      resolved_at timestamptz,
      deleted_at timestamptz
    );
    CREATE INDEX ON tickets (user_id, created_at DESC);
    CREATE INDEX ON tickets (status);
    CREATE TRIGGER trg_tickets_updated_at BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE ticket_comments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      ticket_id uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      platform_user_id uuid,
      body text NOT NULL,
      attachments jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON ticket_comments (ticket_id, created_at);

    -- Notifications + preferences
    CREATE TABLE notifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type text NOT NULL,
      message text NOT NULL,
      metadata_json jsonb,
      link text,
      is_read boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON notifications (user_id, is_read, created_at DESC);
    CREATE INDEX ON notifications (user_id, created_at DESC);

    CREATE TABLE notification_preferences (
      user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      in_app boolean NOT NULL DEFAULT true,
      email boolean NOT NULL DEFAULT true,
      sms boolean NOT NULL DEFAULT false,
      whatsapp boolean NOT NULL DEFAULT false,
      push boolean NOT NULL DEFAULT false,
      digest_frequency text NOT NULL DEFAULT 'immediate', -- immediate | hourly | daily
      quiet_hours_start time,
      quiet_hours_end time,
      quiet_hours_tz text,
      event_overrides jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER trg_notification_preferences_updated_at BEFORE UPDATE ON notification_preferences FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS notification_preferences;
    DROP TABLE IF EXISTS notifications;
    DROP TABLE IF EXISTS ticket_comments;
    DROP TABLE IF EXISTS tickets;
    DROP TABLE IF EXISTS audit_log;
    DROP TABLE IF EXISTS bulk_exports;
    DROP TABLE IF EXISTS bulk_import_failures;
    DROP TABLE IF EXISTS bulk_imports;
    DROP TABLE IF EXISTS bulk_import_previews;
    DROP TABLE IF EXISTS uploaded_files;
    DROP TABLE IF EXISTS user_availability;
    DROP TABLE IF EXISTS holidays;
    DROP TABLE IF EXISTS business_hours;
  `);
};
