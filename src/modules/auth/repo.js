import { tenantQuery } from '../../db/tenant.js';

const USER_COLS = `
  u.id, u.email, u.phone, u.name, u.avatar_r2_key, u.password_hash, u.role, u.role_id,
  u.manager_id, u.team_id, u.is_active, u.last_login_at, u.permissions_json,
  u.session_timeout_minutes, u.track_work_time, u.totp_secret, u.created_at, u.updated_at
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

// Audit a login / logout / expired event so admins can chart per-day login counts.
export const logLoginEvent = async (tenant, { user_id, kind, session_id, ip, user_agent }) => {
  try {
    await tenantQuery(
      tenant,
      `INSERT INTO user_login_events (user_id, kind, session_id, ip, user_agent)
         VALUES ($1, $2, $3, $4, $5)`,
      [user_id, kind, session_id ?? null, ip ?? null, user_agent ?? null],
    );
  } catch (err) {
    // Audit table is best-effort — never fail the login flow over it.
    // (Intentional swallow.)
  }
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
