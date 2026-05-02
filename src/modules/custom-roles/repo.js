import { tenantQuery } from '../../db/tenant.js';

const COLS = `id, name, description, scope, is_system, tab_permissions, feature_permissions, created_at, updated_at`;

export const list = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM custom_roles WHERE deleted_at IS NULL ORDER BY is_system DESC, name ASC`,
  );
  return rows;
};

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM custom_roles WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
};

export const findByName = async (tenant, name) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM custom_roles WHERE name = $1 AND deleted_at IS NULL`,
    [name],
  );
  return rows[0] ?? null;
};

export const insert = async (tenant, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO custom_roles (name, description, scope, is_system, tab_permissions, feature_permissions)
     VALUES ($1,$2,$3,false,$4,$5) RETURNING ${COLS}`,
    [input.name, input.description ?? null, input.scope, input.tab_permissions ?? {}, input.feature_permissions ?? {}],
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
    `UPDATE custom_roles SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING ${COLS}`,
    params,
  );
  return rows[0] ?? null;
};

export const softDelete = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE custom_roles SET deleted_at = now() WHERE id = $1 AND is_system = false`, [id]);
};

export const countUsersWithRole = async (tenant, role_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT count(*)::int AS c FROM users WHERE role_id = $1 AND deleted_at IS NULL`,
    [role_id],
  );
  return rows[0].c;
};
