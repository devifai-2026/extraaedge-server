import { tenantQuery } from '../db/tenant.js';

// Three of the "extra suggestions" from the staff monitoring initiative,
// combined since they're cheap once the underlying data exists
// (user_sessions, user_login_events' geo columns). Shared by the
// GET /analytics/security-anomalies route (on-demand, super_admin dashboard)
// and the weekly-digest worker (scheduled email) — one source of truth for
// what counts as an anomaly.
//
//   concurrent_session — 2+ un-revoked sessions for the same user from
//     different IPs right now. The #1 sign of shared/leaked credentials.
//   new_device — the user's most recent session (last 24h) carries a
//     user_agent that has never appeared in any of their earlier sessions.
//   location_anomaly — the user's most recent login (last 24h) resolved to
//     a different country than the one they've logged in from most often
//     historically. No registered "home" location exists on branches today
//     (no city/geo column there), so this compares each user against their
//     OWN baseline rather than their branch — the standard
//     impossible-travel heuristic, and it needs no new schema.
//
// Heuristics, not proof — reviewed by a human, never auto-acted-on.
export const computeSecurityAnomalies = async (tenant) => {
  const [concurrent, newDevice, locationAnomaly] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT s.user_id, u.name AS user_name, u.role AS user_role,
              count(*)::int AS active_sessions, count(DISTINCT s.ip)::int AS distinct_ips,
              array_agg(DISTINCT s.ip) AS ips
         FROM user_sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.revoked_at IS NULL AND s.expires_at > now()
        GROUP BY s.user_id, u.name, u.role
       HAVING count(*) > 1 AND count(DISTINCT s.ip) > 1`,
    ),
    tenantQuery(
      tenant,
      `WITH latest AS (
         SELECT DISTINCT ON (user_id) user_id, user_agent, ip, issued_at
           FROM user_sessions
           WHERE issued_at > now() - interval '24 hours'
           ORDER BY user_id, issued_at DESC
       )
       SELECT l.user_id, u.name AS user_name, u.role AS user_role, l.user_agent, l.ip, l.issued_at
         FROM latest l
         JOIN users u ON u.id = l.user_id
        WHERE l.user_agent IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM user_sessions s2
             WHERE s2.user_id = l.user_id AND s2.user_agent = l.user_agent AND s2.issued_at < l.issued_at
          )`,
    ),
    tenantQuery(
      tenant,
      `WITH history AS (
         SELECT user_id, geo_country, count(*) AS n
           FROM user_login_events
          WHERE geo_country IS NOT NULL AND created_at < now() - interval '1 day'
          GROUP BY user_id, geo_country
       ),
       usual AS (
         SELECT DISTINCT ON (user_id) user_id, geo_country AS usual_country
           FROM history ORDER BY user_id, n DESC
       ),
       recent AS (
         SELECT DISTINCT ON (user_id) user_id, geo_country, geo_city, created_at
           FROM user_login_events
          WHERE created_at > now() - interval '1 day' AND geo_country IS NOT NULL
          ORDER BY user_id, created_at DESC
       )
       SELECT r.user_id, u.name AS user_name, u.role AS user_role,
              r.geo_country, r.geo_city, r.created_at, us.usual_country
         FROM recent r
         JOIN usual us ON us.user_id = r.user_id
         JOIN users u ON u.id = r.user_id
        WHERE r.geo_country <> us.usual_country`,
    ),
  ]);
  return {
    concurrent_sessions: concurrent.rows,
    new_devices: newDevice.rows,
    location_anomalies: locationAnomaly.rows,
  };
};
