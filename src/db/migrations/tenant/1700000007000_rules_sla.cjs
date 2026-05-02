/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`
    -- Assignment rules + round-robin state
    CREATE TABLE assignment_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      priority integer NOT NULL DEFAULT 100,
      condition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      strategy text NOT NULL,                    -- round_robin | load_balanced | by_geography | by_program | specific_user | team_round_robin
      target_users uuid[],
      target_team_id uuid REFERENCES teams(id) ON DELETE SET NULL,
      fallback_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      respect_working_hours boolean NOT NULL DEFAULT true,
      skip_unavailable boolean NOT NULL DEFAULT true,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON assignment_rules (is_active, priority);
    CREATE TRIGGER trg_assignment_rules_updated_at BEFORE UPDATE ON assignment_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE assignment_rule_state (
      rule_id uuid PRIMARY KEY REFERENCES assignment_rules(id) ON DELETE CASCADE,
      last_assigned_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
      last_assigned_at timestamptz,
      total_assignments integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER trg_assignment_rule_state_updated_at BEFORE UPDATE ON assignment_rule_state FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Lead scoring
    CREATE TABLE lead_score_config (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      criterion text,
      condition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      points integer NOT NULL DEFAULT 0,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE TRIGGER trg_lead_score_config_updated_at BEFORE UPDATE ON lead_score_config FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Generic rule engine (super_admin-defined rules)
    CREATE TABLE rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      event_types text[] NOT NULL,               -- events this rule listens for
      condition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      action_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_active boolean NOT NULL DEFAULT true,
      priority integer NOT NULL DEFAULT 100,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON rules (is_active, priority);
    CREATE INDEX rules_event_types_idx ON rules USING gin (event_types);
    CREATE TRIGGER trg_rules_updated_at BEFORE UPDATE ON rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- SLA policies + alerts
    CREATE TABLE sla_policies (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      condition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      no_activity_hours integer NOT NULL,
      escalate_after_hours integer,
      action_json jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE TRIGGER trg_sla_policies_updated_at BEFORE UPDATE ON sla_policies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE sla_alerts (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      policy_id uuid NOT NULL REFERENCES sla_policies(id) ON DELETE CASCADE,
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
      flagged_at timestamptz NOT NULL DEFAULT now(),
      escalated_at timestamptz,
      resolved_at timestamptz,
      resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
      resolution_reason text
    );
    CREATE INDEX ON sla_alerts (lead_id) WHERE resolved_at IS NULL;
    CREATE INDEX ON sla_alerts (assigned_to, resolved_at);
    CREATE INDEX ON sla_alerts (policy_id, flagged_at DESC);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS sla_alerts;
    DROP TABLE IF EXISTS sla_policies;
    DROP TABLE IF EXISTS rules;
    DROP TABLE IF EXISTS lead_score_config;
    DROP TABLE IF EXISTS assignment_rule_state;
    DROP TABLE IF EXISTS assignment_rules;
  `);
};
