/* eslint-disable camelcase */
exports.up = (pgm) => {
  pgm.sql(`
    -- Bulk campaigns
    CREATE TABLE campaigns_bulk (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      stage text NOT NULL DEFAULT 'DRAFT',        -- DRAFT | IN_PROGRESS | COMPLETED | STOPPED
      channel text NOT NULL,                      -- email | sms | whatsapp | multi
      audience_filter_json jsonb,
      email_template_id uuid REFERENCES email_templates(id),
      sms_template_id uuid REFERENCES sms_templates(id),
      whatsapp_template_id uuid REFERENCES whatsapp_templates(id),
      respects_business_hours boolean NOT NULL DEFAULT true,
      scheduled_at timestamptz,
      started_at timestamptz,
      completed_at timestamptz,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON campaigns_bulk (stage);
    CREATE INDEX ON campaigns_bulk (scheduled_at) WHERE stage = 'DRAFT';
    CREATE TRIGGER trg_campaigns_bulk_updated_at BEFORE UPDATE ON campaigns_bulk FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE campaigns_bulk_stats (
      campaign_id uuid PRIMARY KEY REFERENCES campaigns_bulk(id) ON DELETE CASCADE,
      leads_count integer NOT NULL DEFAULT 0,
      email_triggered integer NOT NULL DEFAULT 0,
      email_delivered integer NOT NULL DEFAULT 0,
      email_not_delivered integer NOT NULL DEFAULT 0,
      email_opened integer NOT NULL DEFAULT 0,
      email_clicked integer NOT NULL DEFAULT 0,
      email_dropped integer NOT NULL DEFAULT 0,
      email_bounced integer NOT NULL DEFAULT 0,
      sms_triggered integer NOT NULL DEFAULT 0,
      sms_delivered integer NOT NULL DEFAULT 0,
      sms_not_delivered integer NOT NULL DEFAULT 0,
      wa_triggered integer NOT NULL DEFAULT 0,
      wa_delivered integer NOT NULL DEFAULT 0,
      wa_not_delivered integer NOT NULL DEFAULT 0,
      wa_seen integer NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TRIGGER trg_campaigns_bulk_stats_updated_at BEFORE UPDATE ON campaigns_bulk_stats FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    -- Drip campaigns
    CREATE TABLE campaigns_drip (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      category text,
      start_time timestamptz,
      active boolean NOT NULL DEFAULT false,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE TRIGGER trg_campaigns_drip_updated_at BEFORE UPDATE ON campaigns_drip FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE campaigns_drip_rules (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      drip_id uuid NOT NULL REFERENCES campaigns_drip(id) ON DELETE CASCADE,
      step_order integer NOT NULL,
      day_offset integer NOT NULL,
      channel text NOT NULL,
      template_id uuid NOT NULL,
      condition_json jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON campaigns_drip_rules (drip_id, step_order);
    CREATE TRIGGER trg_campaigns_drip_rules_updated_at BEFORE UPDATE ON campaigns_drip_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE campaigns_drip_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      drip_id uuid NOT NULL REFERENCES campaigns_drip(id) ON DELETE CASCADE,
      lead_id uuid NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      step_id uuid REFERENCES campaigns_drip_rules(id),
      status text NOT NULL,                      -- queued | sent | failed | skipped
      message_log_id uuid REFERENCES message_log(id),
      executed_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON campaigns_drip_runs (drip_id, lead_id);
    CREATE INDEX ON campaigns_drip_runs (lead_id, executed_at DESC);

    -- Workflow categories (seeded on provision)
    CREATE TABLE workflow_categories (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL UNIQUE,
      description text,
      icon text,
      created_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );

    CREATE TABLE workflows (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name text NOT NULL,
      description text,
      category_id uuid REFERENCES workflow_categories(id),
      trigger_event_types text[],                -- events that can start this workflow
      is_active boolean NOT NULL DEFAULT false,
      start_time timestamptz,
      created_by uuid REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      deleted_at timestamptz
    );
    CREATE INDEX ON workflows (is_active) WHERE deleted_at IS NULL;
    CREATE TRIGGER trg_workflows_updated_at BEFORE UPDATE ON workflows FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TABLE workflow_nodes (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      type text NOT NULL,                        -- trigger | action | condition | wait
      config_json jsonb NOT NULL,
      position_x integer,
      position_y integer,
      order_index integer,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON workflow_nodes (workflow_id);

    CREATE TABLE workflow_edges (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      from_node_id uuid NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
      to_node_id uuid NOT NULL REFERENCES workflow_nodes(id) ON DELETE CASCADE,
      label text
    );
    CREATE INDEX ON workflow_edges (workflow_id);

    CREATE TABLE workflow_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      workflow_id uuid NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'running',    -- running | succeeded | failed | cancelled
      current_node_id uuid REFERENCES workflow_nodes(id),
      started_at timestamptz NOT NULL DEFAULT now(),
      ended_at timestamptz,
      error text,
      context_json jsonb
    );
    CREATE INDEX ON workflow_runs (workflow_id, started_at DESC);
    CREATE INDEX ON workflow_runs (lead_id, started_at DESC);
    CREATE INDEX ON workflow_runs (status);

    CREATE TABLE workflow_run_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id uuid NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
      node_id uuid REFERENCES workflow_nodes(id),
      event_type text NOT NULL,
      payload_json jsonb,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX ON workflow_run_events (run_id, occurred_at);
  `);

  // Seed default workflow categories
  pgm.sql(`
    INSERT INTO workflow_categories (name, description, icon) VALUES
    ('Send immediate communication', 'Trigger a one-time message when an event fires', 'mail'),
    ('Nurture with time-based workflow', 'Multi-step sequence across time', 'clock'),
    ('Assignment & Routing', 'Assign leads based on rules', 'users'),
    ('Re-engagement', 'Win back cold or idle leads', 'refresh')
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP TABLE IF EXISTS workflow_run_events;
    DROP TABLE IF EXISTS workflow_runs;
    DROP TABLE IF EXISTS workflow_edges;
    DROP TABLE IF EXISTS workflow_nodes;
    DROP TABLE IF EXISTS workflows;
    DROP TABLE IF EXISTS workflow_categories;
    DROP TABLE IF EXISTS campaigns_drip_runs;
    DROP TABLE IF EXISTS campaigns_drip_rules;
    DROP TABLE IF EXISTS campaigns_drip;
    DROP TABLE IF EXISTS campaigns_bulk_stats;
    DROP TABLE IF EXISTS campaigns_bulk;
  `);
};
