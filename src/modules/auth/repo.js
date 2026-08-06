import { tenantQuery } from '../../db/tenant.js';
import { resolveIpGeo } from '../../lib/ipGeo.js';
import { logger } from '../../lib/logger.js';

const USER_COLS = `
  u.id, u.email, u.phone, u.name, u.avatar_r2_key, u.password_hash, u.role, u.role_id,
  u.manager_id, u.team_id, u.branch_id, u.is_active, u.last_login_at, u.permissions_json,
  u.session_timeout_minutes, u.track_work_time, u.totp_secret, u.created_at, u.updated_at,
  u.theme_preset, u.theme_primary, u.theme_primary_dark, u.theme_primary_light
`;

export const findUserByEmail = async (tenant, email) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${USER_COLS}, r.tab_permissions, r.feature_permissions, r.scope AS role_scope, r.name AS role_name
       FROM users u
       LEFT JOIN custom_roles r ON r.id = u.role_id
      WHERE u.email = $1 AND u.deleted_at IS NULL`,
    [email],
  );
  return rows[0] ?? null;
};

// Mobile-app login: find the user owning a phone number. Matches on the last
// 10 digits (same expression as users_phone_digits_idx and the device-recordings
// uploader resolution) so '+91 98765-43210' and '9876543210' both hit.
export const findUsersByPhone = async (tenant, digits10) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${USER_COLS}, r.tab_permissions, r.feature_permissions, r.scope AS role_scope, r.name AS role_name
       FROM users u
       LEFT JOIN custom_roles r ON r.id = u.role_id
      WHERE u.deleted_at IS NULL
        AND right(regexp_replace(coalesce(u.phone, ''), '\\D', '', 'g'), 10) = $1`,
    [digits10],
  );
  return rows;
};

export const findUserById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${USER_COLS}, r.tab_permissions, r.feature_permissions, r.scope AS role_scope, r.name AS role_name
       FROM users u
       LEFT JOIN custom_roles r ON r.id = u.role_id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
};

export const touchLogin = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE users SET last_login_at = now() WHERE id = $1`, [id]);
};

// Audit a login / logout / expired event so admins can chart per-day login
// counts. The row is inserted immediately with no geo data so the login
// response is never held up by an outbound HTTP call (see lib/ipGeo.js —
// ip-api.com, not geoip-lite, so most lookups are a real network hop even
// though a short cache absorbs repeat IPs). Geo/ISP resolve in the
// background and UPDATE the row once ready — a login is never blocked or
// left without an audit row over the geo lookup being slow or down.
export const logLoginEvent = async (tenant, { user_id, kind, session_id, ip, user_agent }) => {
  let rowId;
  try {
    const { rows } = await tenantQuery(
      tenant,
      `INSERT INTO user_login_events (user_id, kind, session_id, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [user_id, kind, session_id ?? null, ip ?? null, user_agent ?? null],
    );
    rowId = rows[0]?.id;
  } catch (err) {
    // Audit table is best-effort — never fail the login flow over it.
    return;
  }
  if (!rowId || !ip) return;
  resolveIpGeo(ip)
    .then((geo) => {
      if (!geo) return;
      return tenantQuery(
        tenant,
        `UPDATE user_login_events
            SET lat = $2, lng = $3, geo_city = $4, geo_country = $5, geo_isp = $6, location_source = 'ip'
          WHERE id = $1`,
        [rowId, geo.lat ?? null, geo.lng ?? null, geo.city ?? null, geo.country ?? null, geo.isp ?? null],
      );
    })
    .catch((err) => logger.error({ err: err.message, rowId }, 'logLoginEvent: background geo resolve failed'));
};

// Refines the most recent login event with a precise browser-reported fix —
// see modules/auth/service.js updateLocation / LocationGate.jsx on the FE.
export const updateLatestLoginLocation = async (tenant, userId, { lat, lng }) => {
  await tenantQuery(
    tenant,
    `UPDATE user_login_events
        SET lat = $2, lng = $3, location_source = 'gps'
      WHERE id = (
        SELECT id FROM user_login_events
         WHERE user_id = $1 AND kind = 'login'
         ORDER BY created_at DESC LIMIT 1
      )`,
    [userId, lat, lng],
  );
};

export const updatePasswordHash = async (tenant, id, password_hash) => {
  await tenantQuery(tenant, `UPDATE users SET password_hash = $2 WHERE id = $1`, [id, password_hash]);
};

// Sessions
export const createSession = async (tenant, { user_id, ip, user_agent, expires_at }) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO user_sessions (user_id, ip, user_agent, expires_at)
     VALUES ($1,$2,$3,$4) RETURNING id, last_activity_at`,
    [user_id, ip, user_agent, expires_at],
  );
  return rows[0];
};

export const getSessionLastActivity = async (tenant, session_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT last_activity_at, revoked_at FROM user_sessions WHERE id = $1`,
    [session_id],
  );
  return rows[0] ?? null;
};

export const touchSessionActivity = async (tenant, session_id) => {
  await tenantQuery(tenant, `UPDATE user_sessions SET last_activity_at = now() WHERE id = $1`, [session_id]);
};

export const revokeSession = async (tenant, session_id, idleLogout = false) => {
  await tenantQuery(
    tenant,
    `UPDATE user_sessions SET revoked_at = now(), idle_logout = $2 WHERE id = $1 AND revoked_at IS NULL`,
    [session_id, idleLogout],
  );
};

export const storeRefreshToken = async (tenant, { user_id, session_id, token_hash, expires_at, rotated_from }) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO user_refresh_tokens (user_id, session_id, token_hash, expires_at, rotated_from)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [user_id, session_id, token_hash, expires_at, rotated_from ?? null],
  );
  return rows[0];
};

export const findRefreshToken = async (tenant, token_hash) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT * FROM user_refresh_tokens
      WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [token_hash],
  );
  return rows[0] ?? null;
};

export const revokeRefreshToken = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE user_refresh_tokens SET revoked_at = now() WHERE id = $1`, [id]);
};
