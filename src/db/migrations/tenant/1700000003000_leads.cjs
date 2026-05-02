/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE leads (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      -- Personal
      name text,
      first_name text,
      last_name text,
      alternate_first_name text,
      email citext,
      alternate_email citext,
      phone text,
      whatsapp_number text,
      alternate_contact text,
      gender text,
      language text NOT NULL DEFAULT 'en',

      -- Education (UG/PG)
      ug_degree_id uuid REFERENCES degrees(id) ON DELETE SET NULL,
      ug_specialization_id uuid REFERENCES specializations(id) ON DELETE SET NULL,
      ug_university_id uuid REFERENCES universities(id) ON DELETE SET NULL,
      ug_graduation_year integer,
      pg_degree_id uuid REFERENCES degrees(id) ON DELETE SET NULL,
      pg_specialization_id uuid REFERENCES specializations(id) ON DELETE SET NULL,
      pg_university_id uuid REFERENCES universities(id) ON DELETE SET NULL,
      pg_graduation_year integer,

      -- Address
      country_id uuid REFERENCES countries(id) ON DELETE SET NULL,
      state_id uuid REFERENCES states(id) ON DELETE SET NULL,
      district text,
      city text,
      address text,
      pincode text,

      -- Program / stage
      program_id uuid REFERENCES programs(id) ON DELETE SET NULL,
      stage_id uuid REFERENCES lead_stages(id) ON DELETE RESTRICT,
      sub_stage_id uuid REFERENCES lead_sub_stages(id) ON DELETE SET NULL,
      remarks text,
      closure_remarks text,

      -- Ownership (denormalized from lead_assignments.is_active=true)
      assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
      team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,

      -- Scoring
      lead_score numeric(10,2) NOT NULL DEFAULT 0,
      lead_score_manual_override numeric(10,2),
      engagement_score numeric(10,2) NOT NULL DEFAULT 0,
      lead_value text,

      -- Referral
      referred_by_lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
      referral_code_used text,
      referral_source text,

      -- Attribution — first + last touch snapshot
      first_touch_campaign_id uuid,
      first_touch_channel text,
      first_touch_source text,
      first_touch_medium text,
      first_touch_at timestamptz,
      last_touch_campaign_id uuid,
      last_touch_channel text,
      last_touch_source text,
      last_touch_medium text,
      last_touch_at timestamptz,

      -- Raw-data verification
      mobile_verified_at timestamptz,
      email_verified_at timestamptz,
      is_cold boolean NOT NULL DEFAULT false,

      -- Lifecycle
      converted_at timestamptz,
      merged_into_id uuid REFERENCES leads(id) ON DELETE SET NULL,
      deleted_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      last_activity_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON leads (stage_id);
    CREATE INDEX ON leads (sub_stage_id);
    CREATE INDEX ON leads (assigned_to);
    CREATE INDEX ON leads (team_id);
    CREATE INDEX ON leads (program_id);
    CREATE INDEX ON leads (created_at DESC);
    CREATE INDEX ON leads (last_activity_at DESC);
    CREATE INDEX ON leads (phone) WHERE deleted_at IS NULL;
    CREATE INDEX ON leads (email) WHERE deleted_at IS NULL;
    CREATE INDEX ON leads (whatsapp_number) WHERE deleted_at IS NULL;
    CREATE INDEX ON leads (is_cold) WHERE deleted_at IS NULL;
    CREATE INDEX leads_search_idx ON leads USING gin (
      to_tsvector('simple', coalesce(name,'') || ' ' || coalesce(email::text,'') || ' ' || coalesce(phone,''))
    );
    CREATE INDEX leads_phone_trgm ON leads USING gin (phone gin_trgm_ops) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_leads_updated_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE lead_family (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
      father_name text, father_mobile text, father_email citext,
      mother_name text, mother_mobile text, mother_email citext,
      guardian_name text, guardian_mobile text, guardian_email citext,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER trg_lead_family_updated_at BEFORE UPDATE ON lead_family FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE lead_source_attributions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      channel_id uuid REFERENCES lead_channels(id),
      source_id uuid REFERENCES lead_sources_dict(id),
      campaign_id uuid REFERENCES lead_campaigns_dict(id),
      medium_id uuid REFERENCES lead_mediums(id),
      captured_at timestamptz NOT NULL DEFAULT now(),
      is_primary boolean NOT NULL DEFAULT false
    );
    CREATE INDEX ON lead_source_attributions (lead_id);

    CREATE TABLE lead_assignments (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      from_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
      assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
      assignment_type text NOT NULL,            -- assign | reassign | auto_assign | refer | unassign
      reason text,
      is_active boolean NOT NULL DEFAULT true,
      status text,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX one_active_assignment_per_lead ON lead_assignments (lead_id) WHERE is_active;
    CREATE INDEX ON lead_assignments (assigned_to);
    CREATE INDEX ON lead_assignments (lead_id, created_at DESC);

    CREATE TABLE lead_activities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      type text NOT NULL,                       -- stage_changed | assigned | note_added | email_sent | ...
      summary text,
      metadata_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON lead_activities (lead_id, created_at DESC);
    CREATE INDEX ON lead_activities (user_id, created_at DESC);
    CREATE INDEX ON lead_activities (type, created_at DESC);

    CREATE TABLE lead_notes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      body text NOT NULL,
      visibility text NOT NULL DEFAULT 'internal',
      attachments jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON lead_notes (lead_id, created_at DESC);
    CREATE TRIGGER trg_lead_notes_updated_at BEFORE UPDATE ON lead_notes FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE lead_followups (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      next_action_datetime timestamptz NOT NULL,
      comment text,
      stage_id uuid REFERENCES lead_stages(id),
      sub_stage_id uuid REFERENCES lead_sub_stages(id),
      status text NOT NULL DEFAULT 'planned',   -- planned | done | missed | cancelled
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      completed_at timestamptz,
      completed_by uuid REFERENCES users(id) ON DELETE SET NULL,

      -- Recurrence (RFC 5545 RRULE)
      recurrence_rule text,
      recurrence_parent_id uuid REFERENCES lead_followups(id) ON DELETE CASCADE,
      recurrence_end timestamptz,

      -- Reminder bookkeeping (prevents double-sends)
      reminder_sent_at timestamptz,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON lead_followups (lead_id, next_action_datetime);
    CREATE INDEX ON lead_followups (created_by, next_action_datetime);
    CREATE INDEX ON lead_followups (status, next_action_datetime) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_lead_followups_updated_at BEFORE UPDATE ON lead_followups FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Tag associations
    CREATE TABLE lead_tags (
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
      assigned_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (lead_id, tag_id)
    );
    CREATE INDEX ON lead_tags (tag_id);

    -- Custom field values
    CREATE TABLE lead_custom_values (
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      field_id uuid NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
      value jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (lead_id, field_id)
    );
    CREATE INDEX lead_custom_values_value_idx ON lead_custom_values USING gin (value);

    -- Saved filters (per user)
    CREATE TABLE saved_filters (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name text NOT NULL,
      filter_json jsonb NOT NULL,
      is_shared boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz,
      UNIQUE (user_id, name)
    );
    CREATE TRIGGER trg_saved_filters_updated_at BEFORE UPDATE ON saved_filters FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Duplicates
    CREATE TABLE lead_duplicate_matches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_a_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      lead_b_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      match_on text NOT NULL,                    -- phone | email | whatsapp | composite
      confidence numeric(4,3) NOT NULL,
      status text NOT NULL DEFAULT 'open',       -- open | ignored | merged
      reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON lead_duplicate_matches (status) WHERE status = 'open';
    CREATE INDEX ON lead_duplicate_matches (lead_a_id);
    CREATE INDEX ON lead_duplicate_matches (lead_b_id);

    CREATE TABLE lead_merge_log (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      surviving_lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      merged_lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      merged_by uuid REFERENCES users(id) ON DELETE SET NULL,
      field_decisions_json jsonb,
      activity_count_transferred integer NOT NULL DEFAULT 0,
      note_count_transferred integer NOT NULL DEFAULT 0,
      message_count_transferred integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON lead_merge_log (surviving_lead_id);

    -- Attribution touches
    CREATE TABLE lead_touches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      touch_type text NOT NULL,
      campaign_id uuid,
      channel text,
      source text,
      medium text,
      metadata_json jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON lead_touches (lead_id, occurred_at DESC);
    CREATE INDEX ON lead_touches (campaign_id);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS lead_touches;
    DROP TABLE IF EXISTS lead_merge_log;
    DROP TABLE IF EXISTS lead_duplicate_matches;
    DROP TABLE IF EXISTS saved_filters;
    DROP TABLE IF EXISTS lead_custom_values;
    DROP TABLE IF EXISTS lead_tags;
    DROP TABLE IF EXISTS lead_followups;
    DROP TABLE IF EXISTS lead_notes;
    DROP TABLE IF EXISTS lead_activities;
    DROP TABLE IF EXISTS lead_assignments;
    DROP TABLE IF EXISTS lead_source_attributions;
    DROP TABLE IF EXISTS lead_family;
    DROP TABLE IF EXISTS leads CASCADE;
  `);
};
