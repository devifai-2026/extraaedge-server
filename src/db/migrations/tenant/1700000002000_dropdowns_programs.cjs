/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`
    -- Lead stages + sub-stages
    CREATE TABLE lead_stages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      code text NOT NULL UNIQUE,
      order_index integer NOT NULL DEFAULT 0,
      color text,
      is_terminal boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE TRIGGER trg_lead_stages_updated_at BEFORE UPDATE ON lead_stages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE lead_sub_stages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      stage_id uuid REFERENCES lead_stages(id) ON DELETE CASCADE,
      name text NOT NULL,
      is_default boolean NOT NULL DEFAULT false,
      order_index integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON lead_sub_stages (stage_id);
    CREATE TRIGGER trg_lead_sub_stages_updated_at BEFORE UPDATE ON lead_sub_stages FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Source attribution dictionaries
    CREATE TABLE lead_channels (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      is_active boolean NOT NULL DEFAULT true,
      order_index integer NOT NULL DEFAULT 0,
      deleted_at timestamptz
    );

    CREATE TABLE lead_sources_dict (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      is_active boolean NOT NULL DEFAULT true,
      order_index integer NOT NULL DEFAULT 0,
      deleted_at timestamptz
    );

    CREATE TABLE lead_campaigns_dict (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      is_active boolean NOT NULL DEFAULT true,
      order_index integer NOT NULL DEFAULT 0,
      deleted_at timestamptz
    );

    CREATE TABLE lead_mediums (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      is_active boolean NOT NULL DEFAULT true,
      order_index integer NOT NULL DEFAULT 0,
      deleted_at timestamptz
    );

    -- Geo
    CREATE TABLE countries (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      iso text,
      is_active boolean NOT NULL DEFAULT true,
      deleted_at timestamptz
    );

    CREATE TABLE states (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      country_id uuid REFERENCES countries(id) ON DELETE CASCADE,
      name text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      deleted_at timestamptz,
      UNIQUE (country_id, name)
    );

    -- Education / demographics
    CREATE TABLE genders (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      is_active boolean NOT NULL DEFAULT true,
      deleted_at timestamptz
    );
    CREATE TABLE degrees (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      level text NOT NULL,                   -- UG | PG | Diploma | Doctorate
      name text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      deleted_at timestamptz,
      UNIQUE (level, name)
    );
    CREATE TABLE specializations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      is_active boolean NOT NULL DEFAULT true,
      deleted_at timestamptz
    );
    CREATE TABLE universities (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      country_id uuid REFERENCES countries(id),
      is_active boolean NOT NULL DEFAULT true,
      deleted_at timestamptz
    );

    -- Programs
    CREATE TABLE programs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      code text UNIQUE,
      description text,
      category text,                         -- abroad | domestic | coaching
      type text,                             -- online | offline | hybrid
      price numeric(12,2),
      currency text,
      discount_price numeric(12,2),
      duration_value integer,
      duration_unit text,                    -- days | months | years
      eligibility text,
      intake_month text,
      country text,
      is_active boolean NOT NULL DEFAULT true,
      is_featured boolean NOT NULL DEFAULT false,
      brochure_url text,
      image_url text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON programs (category) WHERE deleted_at IS NULL;
    CREATE INDEX ON programs (is_active, is_featured);
    CREATE TRIGGER trg_programs_updated_at BEFORE UPDATE ON programs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Tags (for lead categorization)
    CREATE TABLE tags (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      color text,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE TRIGGER trg_tags_updated_at BEFORE UPDATE ON tags FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Custom fields (tenant-defined)
    CREATE TABLE custom_field_definitions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      entity text NOT NULL,                  -- lead | user | program
      key text NOT NULL,                     -- snake_case
      label text NOT NULL,
      field_type text NOT NULL,              -- text | number | select | multiselect | date | boolean | url | email | textarea
      options_json jsonb,                    -- for select/multiselect
      validation_json jsonb,                 -- { min, max, regex, required }
      is_required boolean NOT NULL DEFAULT false,
      is_searchable boolean NOT NULL DEFAULT false,
      show_in_list boolean NOT NULL DEFAULT false,
      show_in_form_tab text,
      order_index integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE UNIQUE INDEX custom_field_defs_unique_key ON custom_field_definitions (entity, key) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_custom_field_defs_updated_at BEFORE UPDATE ON custom_field_definitions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS custom_field_definitions;
    DROP TABLE IF EXISTS tags;
    DROP TABLE IF EXISTS programs;
    DROP TABLE IF EXISTS universities;
    DROP TABLE IF EXISTS specializations;
    DROP TABLE IF EXISTS degrees;
    DROP TABLE IF EXISTS genders;
    DROP TABLE IF EXISTS states;
    DROP TABLE IF EXISTS countries;
    DROP TABLE IF EXISTS lead_mediums;
    DROP TABLE IF EXISTS lead_campaigns_dict;
    DROP TABLE IF EXISTS lead_sources_dict;
    DROP TABLE IF EXISTS lead_channels;
    DROP TABLE IF EXISTS lead_sub_stages;
    DROP TABLE IF EXISTS lead_stages;
  `);
};
