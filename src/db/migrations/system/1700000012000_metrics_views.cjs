/* eslint-disable camelcase */
// Grafana metrics layer — curated read-only VIEWS over platform_request_log so
// dashboards query a stable surface (never the raw table / secret bodies).
//
//   metrics_requests        — one row per API request (lean columns Grafana needs)
//   metrics_requests_1m      — per-minute rollup: count, errors, p50/p95/p99 latency
//   metrics_endpoint_1h      — per-endpoint hourly rollup (route + method)
//   metrics_status_1m        — per-minute counts bucketed by status class (2xx/4xx/5xx)
//
// Grafana connects with a read-only Postgres user (created out-of-band in Render
// with SELECT on these views) — see render.yaml notes. Views are SECURITY
// INVOKER by default; we GRANT SELECT to a `grafana_ro` role if it exists.

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE VIEW metrics_requests AS
      SELECT
        id, created_at, method, path, route, status_code, duration_ms,
        is_error, category, tenant_slug,
        CASE
          WHEN status_code >= 500 THEN '5xx'
          WHEN status_code >= 400 THEN '4xx'
          WHEN status_code >= 300 THEN '3xx'
          WHEN status_code >= 200 THEN '2xx'
          ELSE 'other'
        END AS status_class
      FROM platform_request_log;

    -- Per-minute latency + volume rollup (the main "API response time" panel).
    CREATE OR REPLACE VIEW metrics_requests_1m AS
      SELECT
        date_trunc('minute', created_at) AS ts,
        count(*)::bigint                                              AS requests,
        count(*) FILTER (WHERE is_error)::bigint                      AS errors,
        round(avg(duration_ms))::int                                 AS avg_ms,
        percentile_disc(0.50) WITHIN GROUP (ORDER BY duration_ms)     AS p50_ms,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)     AS p95_ms,
        percentile_disc(0.99) WITHIN GROUP (ORDER BY duration_ms)     AS p99_ms
      FROM platform_request_log
      GROUP BY 1;

    -- Per-endpoint hourly rollup (slowest / busiest endpoints table).
    CREATE OR REPLACE VIEW metrics_endpoint_1h AS
      SELECT
        date_trunc('hour', created_at) AS ts,
        method,
        COALESCE(route, path) AS endpoint,
        count(*)::bigint                                             AS requests,
        count(*) FILTER (WHERE is_error)::bigint                     AS errors,
        round(avg(duration_ms))::int                                AS avg_ms,
        percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)    AS p95_ms
      FROM platform_request_log
      GROUP BY 1, 2, 3;

    -- Per-minute status-class counts (stacked 2xx/4xx/5xx panel).
    CREATE OR REPLACE VIEW metrics_status_1m AS
      SELECT
        date_trunc('minute', created_at) AS ts,
        CASE
          WHEN status_code >= 500 THEN '5xx'
          WHEN status_code >= 400 THEN '4xx'
          WHEN status_code >= 300 THEN '3xx'
          WHEN status_code >= 200 THEN '2xx'
          ELSE 'other'
        END AS status_class,
        count(*)::bigint AS requests
      FROM platform_request_log
      GROUP BY 1, 2;

    -- Grant to a read-only Grafana role if it's been provisioned.
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
        GRANT SELECT ON metrics_requests, metrics_requests_1m, metrics_endpoint_1h, metrics_status_1m TO grafana_ro;
      END IF;
    END$$;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    DROP VIEW IF EXISTS metrics_status_1m;
    DROP VIEW IF EXISTS metrics_endpoint_1h;
    DROP VIEW IF EXISTS metrics_requests_1m;
    DROP VIEW IF EXISTS metrics_requests;
  `);
};
