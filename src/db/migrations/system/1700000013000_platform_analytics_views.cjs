/* eslint-disable camelcase */
// Platform analytics VIEWS for the Grafana product-owner dashboards. These read
// system-level tables only (tenants, plans, support tickets, request log) — the
// data a platform owner watches across the whole product. Per-tenant BUSINESS
// data (leads/admissions/revenue/LMS) lives in separate tenant databases and is
// NOT reachable from this one connection; that cross-DB rollup is a later phase.
//
//   metrics_tenants           — tenant roster + status + plan
//   metrics_tenant_activity_1h — requests per tenant per hour (who's active)
//   metrics_support_open       — open support tickets by priority
//   metrics_signups_1d         — tenants created per day (growth curve)

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW metrics_tenants AS
      SELECT t.id, t.slug, t.name, t.status, t.created_at,
             p.name AS plan_name
        FROM tenants t
        LEFT JOIN plans p ON p.id = t.plan_id;

    CREATE OR REPLACE VIEW metrics_tenant_activity_1h AS
      SELECT date_trunc('hour', created_at) AS ts,
             COALESCE(tenant_slug, '(platform)') AS tenant_slug,
             count(*)::bigint AS requests,
             count(*) FILTER (WHERE is_error)::bigint AS errors
        FROM platform_request_log
       GROUP BY 1, 2;

    CREATE OR REPLACE VIEW metrics_support_open AS
      SELECT COALESCE(priority, 'unset') AS priority,
             status,
             count(*)::bigint AS tickets
        FROM support_tickets
       WHERE status <> 'closed' AND deleted_at IS NULL
       GROUP BY 1, 2;

    CREATE OR REPLACE VIEW metrics_signups_1d AS
      SELECT date_trunc('day', created_at) AS ts, count(*)::bigint AS tenants
        FROM tenants
       GROUP BY 1;

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
        GRANT SELECT ON metrics_tenants, metrics_tenant_activity_1h, metrics_support_open, metrics_signups_1d TO grafana_ro;
      END IF;
    END$$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP VIEW IF EXISTS metrics_signups_1d;
    DROP VIEW IF EXISTS metrics_support_open;
    DROP VIEW IF EXISTS metrics_tenant_activity_1h;
    DROP VIEW IF EXISTS metrics_tenants;
  `);
};
