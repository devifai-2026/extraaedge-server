import { tenantQuery } from '../../db/tenant.js';

const COLS = `
  u.id, u.email, u.phone, u.name, u.avatar_r2_key, u.role, u.role_id,
  u.manager_id, u.team_id, u.is_active, u.last_login_at,
  u.session_timeout_minutes, u.track_work_time, u.permissions_json,
  u.created_at, u.updated_at, r.name AS role_name, r.scope AS role_scope
`;

export const list = async (tenant, { q, role, team_id, manager_id, is_active, page, limit }) => {
  const conds = ['u.deleted_at IS NULL'];
  const params = [];
  if (role) { params.push(role); conds.push(`u.role = $${params.length}`); }
  if (team_id) { params.push(team_id); conds.push(`u.team_id = $${params.length}`); }
  if (manager_id) { params.push(manager_id); conds.push(`u.manager_id = $${params.length}`); }
  if (is_active === 'true') conds.push('u.is_active = true');
  if (is_active === 'false') conds.push('u.is_active = false');
  if (q) {
    params.push(`%${q}%`);
    conds.push(`(u.name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR u.phone ILIKE $${params.length})`);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const countParams = params.slice(0, -2);
  const [{ rows }, { rows: countRows }] = await Promise.all([
    tenantQuery(
      tenant,
      `SELECT ${COLS}
         FROM users u LEFT JOIN custom_roles r ON r.id = u.role_id
         ${where}
         ORDER BY u.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    tenantQuery(tenant, `SELECT count(*)::int AS total FROM users u ${where}`, countParams),
  ]);
  return { rows, total: countRows[0].total };
};

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM users u LEFT JOIN custom_roles r ON r.id = u.role_id WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
};

export const findByEmail = async (tenant, email) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM users u LEFT JOIN custom_roles r ON r.id = u.role_id WHERE u.email = $1 AND u.deleted_at IS NULL`,
    [email],
  );
  return rows[0] ?? null;
};

export const insert = async (tenant, input, password_hash) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO users (name, email, phone, password_hash, role, role_id, manager_id, team_id, track_work_time, session_timeout_minutes, permissions_json, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9, true), COALESCE($10, 15), $11, true)
     RETURNING id, email, phone, name, avatar_r2_key, role, role_id, manager_id, team_id, is_active, session_timeout_minutes, track_work_time, permissions_json, created_at, updated_at`,
    [
      input.name,
      input.email,
      input.phone ?? null,
      password_hash,
      input.role,
      input.role_id ?? null,
      input.manager_id ?? null,
      input.team_id ?? null,
      input.track_work_time ?? null,
      input.session_timeout_minutes ?? null,
      input.permissions_json ?? null,
    ],
  );
  return rows[0];
};

export const update = async (tenant, id, updates) => {
  const fields = [];
  const params = [];
  let i = 1;
  for (const [k, v] of Object.entries(updates)) {
    fields.push(`${k} = $${i}`);
    params.push(v);
    i += 1;
  }
  if (!fields.length) return findById(tenant, id);
  params.push(id);
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE users SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL
     RETURNING id, email, phone, name, role, role_id, manager_id, team_id, is_active, session_timeout_minutes, track_work_time, permissions_json, updated_at`,
    params,
  );
  return rows[0] ?? null;
};

export const updatePasswordHash = async (tenant, id, password_hash) => {
  await tenantQuery(tenant, `UPDATE users SET password_hash = $2 WHERE id = $1`, [id, password_hash]);
};

export const softDelete = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE users SET deleted_at = now(), is_active = false WHERE id = $1`, [id]);
};

export const getUpdatedAt = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT updated_at FROM users WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0]?.updated_at ?? null;
};

// Recursive CTE for my-team (manager hierarchy).
export const teamHierarchy = async (tenant, root_user_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `WITH RECURSIVE team AS (
       SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL
       UNION
       SELECT u.id FROM users u JOIN team t ON u.manager_id = t.id WHERE u.deleted_at IS NULL
     )
     SELECT id FROM team`,
    [root_user_id],
  );
  return rows.map((r) => r.id);
};

export const teamUsers = async (tenant, ids) => {
  if (!ids.length) return [];
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM users u LEFT JOIN custom_roles r ON r.id = u.role_id
      WHERE u.id = ANY($1::uuid[]) AND u.deleted_at IS NULL
      ORDER BY u.role DESC, u.name`,
    [ids],
  );
  return rows;
};
