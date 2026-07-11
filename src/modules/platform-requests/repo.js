// Query layer for the Danger Request Log. SQL only.
import { sysQuery } from '../../db/system.js';
import { selectMany, selectOne, selectCount, whereBuilder, buildPagination } from '../../lib/dbHelpers.js';

// List view: omit the heavy body columns; the row-detail endpoint fetches them.
const LIST_COLUMNS = `
  r.id, r.request_id, r.created_at, r.actor_email, r.actor_role, r.is_platform_actor,
  r.tenant_id, r.tenant_slug, r.method, r.path, r.route, r.status_code,
  r.duration_ms, r.is_error, r.error_code, r.error_message, r.category,
  r.body_truncated, r.ip
`;

const buildWhere = (filter) => {
  const wb = whereBuilder();
  wb.add(filter.tenant_id,   (_, i) => `r.tenant_id = $${i}`);
  wb.add(filter.tenant_slug, (_, i) => `r.tenant_slug = $${i}`);
  wb.add(filter.actor_email, (_, i) => `r.actor_email = $${i}`);
  wb.add(filter.method,      (_, i) => `r.method = $${i}`);
  wb.add(filter.category,    (_, i) => `r.category = $${i}`);
  wb.add(filter.status_code, (_, i) => `r.status_code = $${i}`);
  wb.add(filter.request_id,  (_, i) => `r.request_id = $${i}`);
  // Date range (inclusive). Caller passes ISO timestamps.
  wb.add(filter.date_from,   (_, i) => `r.created_at >= $${i}::timestamptz`);
  wb.add(filter.date_to,     (_, i) => `r.created_at <= $${i}::timestamptz`);
  // Path substring search.
  wb.add(filter.path,        (_, i) => `r.path ILIKE $${i}`, (v) => `%${v}%`);
  // errors_only=true → only non-2xx.
  if (filter.errors_only === true || filter.errors_only === 'true') {
    wb.addRaw('r.is_error = true');
  }
  // status_class e.g. '4' or '5' → 4xx / 5xx bucket.
  if (filter.status_class) {
    wb.add(Number(filter.status_class) * 100, (_, i) => `(r.status_code >= $${i} AND r.status_code < $${i} + 100)`);
  }
  return wb;
};

export const listAndCount = async (filter = {}) => {
  const wb = buildWhere(filter);
  const total = await selectCount(sysQuery, `SELECT count(*)::int AS count FROM platform_request_log r ${wb.sql}`, wb.params);
  const pg = buildPagination(filter.page, filter.limit, wb.params.length);
  const rows = await selectMany(
    sysQuery,
    `SELECT ${LIST_COLUMNS} FROM platform_request_log r ${wb.sql}
     ORDER BY r.created_at DESC ${pg.limitClause}`,
    [...wb.params, ...pg.params],
  );
  return { rows, total, page: pg.page, limit: pg.limit };
};

// Full row including request/response bodies.
export const getById = (id) =>
  selectOne(sysQuery, `SELECT r.* FROM platform_request_log r WHERE r.id = $1`, [id]);

// All rows sharing a request_id (a single logical request — usually one row,
// but handy for correlating).
export const getByRequestId = (requestId) =>
  selectMany(sysQuery, `SELECT r.* FROM platform_request_log r WHERE r.request_id = $1 ORDER BY r.created_at`, [requestId]);

// Distinct values to populate filter dropdowns in the UI.
// Cross-tenant API metrics for the live graphs. All aggregates span EVERY
// tenant (no tenant filter) — this is the product-wide monitoring view.
// `sinceExpr` is a safe interval literal chosen by the controller; `bucket` is
// 'minute' or 'hour'. Returns { summary, series, statusSeries, topEndpoints }.
export const metrics = async ({ sinceExpr, bucket }) => {
  const since = `now() - interval '${sinceExpr}'`;
  const [summary, series, statusSeries, topEndpoints] = await Promise.all([
    selectOne(
      sysQuery,
      `SELECT
         count(*)::int AS requests,
         count(*) FILTER (WHERE is_error)::int AS errors,
         round(100.0 * count(*) FILTER (WHERE is_error) / NULLIF(count(*),0), 2)::float AS error_rate,
         round(avg(duration_ms))::int AS avg_ms,
         percentile_disc(0.50) WITHIN GROUP (ORDER BY duration_ms)::int AS p50_ms,
         percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms,
         percentile_disc(0.99) WITHIN GROUP (ORDER BY duration_ms)::int AS p99_ms,
         count(DISTINCT tenant_slug)::int AS active_tenants
       FROM platform_request_log WHERE created_at >= ${since}`,
    ),
    selectMany(
      sysQuery,
      `SELECT date_trunc('${bucket}', created_at) AS ts,
              count(*)::int AS requests,
              count(*) FILTER (WHERE is_error)::int AS errors,
              round(avg(duration_ms))::int AS avg_ms,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms,
              percentile_disc(0.99) WITHIN GROUP (ORDER BY duration_ms)::int AS p99_ms
         FROM platform_request_log WHERE created_at >= ${since}
        GROUP BY 1 ORDER BY 1`,
    ),
    selectMany(
      sysQuery,
      `SELECT date_trunc('${bucket}', created_at) AS ts,
              count(*) FILTER (WHERE status_code >= 200 AND status_code < 300)::int AS s2xx,
              count(*) FILTER (WHERE status_code >= 300 AND status_code < 400)::int AS s3xx,
              count(*) FILTER (WHERE status_code >= 400 AND status_code < 500)::int AS s4xx,
              count(*) FILTER (WHERE status_code >= 500)::int AS s5xx
         FROM platform_request_log WHERE created_at >= ${since}
        GROUP BY 1 ORDER BY 1`,
    ),
    selectMany(
      sysQuery,
      `SELECT COALESCE(route, path) AS endpoint, method,
              count(*)::int AS requests,
              count(*) FILTER (WHERE is_error)::int AS errors,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms
         FROM platform_request_log WHERE created_at >= ${since}
        GROUP BY 1, 2 ORDER BY requests DESC LIMIT 15`,
    ),
  ]);
  return { summary, series, statusSeries, topEndpoints };
};

export const facets = async () => {
  const [methods, categories, tenants] = await Promise.all([
    selectMany(sysQuery, `SELECT DISTINCT method FROM platform_request_log ORDER BY method`),
    selectMany(sysQuery, `SELECT DISTINCT category FROM platform_request_log WHERE category IS NOT NULL ORDER BY category`),
    selectMany(sysQuery, `SELECT DISTINCT tenant_slug FROM platform_request_log WHERE tenant_slug IS NOT NULL ORDER BY tenant_slug`),
  ]);
  return {
    methods: methods.map((r) => r.method),
    categories: categories.map((r) => r.category),
    tenants: tenants.map((r) => r.tenant_slug),
  };
};
