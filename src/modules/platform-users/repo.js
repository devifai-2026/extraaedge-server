import { sysQuery } from '../../db/system.js';

const COLUMNS = 'id, name, email, phone, role, is_active, last_login_at, created_at, updated_at';

export const list = async () => {
  const { rows } = await sysQuery(`SELECT ${COLUMNS} FROM platform_users WHERE deleted_at IS NULL ORDER BY created_at DESC`);
  return rows;
};

export const findByEmail = async (email) => {
  const { rows } = await sysQuery(
    `SELECT id, name, email, phone, role, is_active, password_hash, totp_secret FROM platform_users
      WHERE email = $1 AND deleted_at IS NULL LIMIT 1`,
    [email],
  );
  return rows[0] ?? null;
};

export const findById = async (id) => {
  const { rows } = await sysQuery(`SELECT ${COLUMNS} FROM platform_users WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0] ?? null;
};

export const insert = async ({ name, email, phone, password_hash, role }) => {
  const { rows } = await sysQuery(
    `INSERT INTO platform_users (name, email, phone, password_hash, role, is_active)
     VALUES ($1,$2,$3,$4,$5,true) RETURNING ${COLUMNS}`,
    [name, email, phone ?? null, password_hash, role],
  );
  return rows[0];
};

export const update = async (id, updates) => {
  const fields = [];
  const params = [];
  let i = 1;
  for (const [k, v] of Object.entries(updates)) {
    fields.push(`${k} = $${i}`);
    params.push(v);
    i += 1;
  }
  if (!fields.length) return findById(id);
  params.push(id);
  const { rows } = await sysQuery(
    `UPDATE platform_users SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING ${COLUMNS}`,
    params,
  );
  return rows[0] ?? null;
};

export const updatePasswordHash = async (id, password_hash) => {
  await sysQuery(`UPDATE platform_users SET password_hash = $2 WHERE id = $1`, [id, password_hash]);
};

export const softDelete = async (id) => {
  await sysQuery(`UPDATE platform_users SET deleted_at = now(), is_active = false WHERE id = $1`, [id]);
};

export const touchLogin = async (id) => {
  await sysQuery(`UPDATE platform_users SET last_login_at = now() WHERE id = $1`, [id]);
};

// Sessions
export const insertSession = async ({ platform_user_id, refresh_token_hash, expires_at, ip, user_agent }) => {
  const { rows } = await sysQuery(
    `INSERT INTO platform_user_sessions (platform_user_id, refresh_token_hash, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, last_activity_at`,
    [platform_user_id, refresh_token_hash, expires_at, ip, user_agent],
  );
  return rows[0];
};

export const findSessionByTokenHash = async (hash) => {
  const { rows } = await sysQuery(
    `SELECT * FROM platform_user_sessions WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [hash],
  );
  return rows[0] ?? null;
};

export const touchSession = async (id) => {
  await sysQuery(`UPDATE platform_user_sessions SET last_activity_at = now() WHERE id = $1`, [id]);
};

export const revokeSession = async (id) => {
  await sysQuery(`UPDATE platform_user_sessions SET revoked_at = now() WHERE id = $1`, [id]);
};

export const getSessionLastActivity = async (id) => {
  const { rows } = await sysQuery(`SELECT last_activity_at FROM platform_user_sessions WHERE id = $1`, [id]);
  return rows[0]?.last_activity_at ?? null;
};
