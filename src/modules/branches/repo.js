import { tenantQuery } from '../../db/tenant.js';

const COLS = `
  b.id, b.name, b.code, b.branch_manager_id, b.is_active,
  b.created_at, b.updated_at,
  m.name AS branch_manager_name, m.email AS branch_manager_email
`;

const FROM = `
  FROM branches b
  LEFT JOIN users m ON m.id = b.branch_manager_id AND m.deleted_at IS NULL
`;

// Count of live branches — drives the FE "needs branch setup" prompt.
export const countActive = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT count(*)::int AS n FROM branches WHERE deleted_at IS NULL`,
  );
  return rows[0]?.n ?? 0;
};

export const list = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS},
            (SELECT count(*)::int FROM users u WHERE u.branch_id = b.id AND u.deleted_at IS NULL) AS member_count
       ${FROM}
      WHERE b.deleted_at IS NULL
      ORDER BY b.name`,
  );
  return rows;
};

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} ${FROM} WHERE b.id = $1 AND b.deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
};

export const findByName = async (tenant, name) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} ${FROM} WHERE lower(b.name) = lower($1) AND b.deleted_at IS NULL`,
    [name],
  );
  return rows[0] ?? null;
};

// The live branch a given user heads (if any).
export const findByManager = async (tenant, manager_id) => {
  if (!manager_id) return null;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} ${FROM} WHERE b.branch_manager_id = $1 AND b.deleted_at IS NULL LIMIT 1`,
    [manager_id],
  );
  return rows[0] ?? null;
};

export const insert = async (tenant, { name, code, branch_manager_id, is_active }) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO branches (name, code, branch_manager_id, is_active)
     VALUES ($1, $2, $3, COALESCE($4, true))
     RETURNING id`,
    [name, code ?? null, branch_manager_id ?? null, is_active ?? null],
  );
  return findById(tenant, rows[0].id);
};

export const update = async (tenant, id, updates) => {
  const fields = [];
  const params = [];
  let i = 1;
  for (const k of ['name', 'code', 'branch_manager_id', 'is_active']) {
    if (Object.prototype.hasOwnProperty.call(updates, k)) {
      fields.push(`${k} = $${i}`);
      params.push(updates[k]);
      i += 1;
    }
  }
  if (!fields.length) return findById(tenant, id);
  params.push(id);
  await tenantQuery(
    tenant,
    `UPDATE branches SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL`,
    params,
  );
  return findById(tenant, id);
};

export const softDelete = async (tenant, id) => {
  await tenantQuery(
    tenant,
    `UPDATE branches SET deleted_at = now(), is_active = false WHERE id = $1`,
    [id],
  );
};

export const memberCount = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT count(*)::int AS n FROM users WHERE branch_id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0]?.n ?? 0;
};

// Set / move a user's branch. Pass null to clear.
export const setUserBranch = async (tenant, user_id, branch_id) => {
  await tenantQuery(
    tenant,
    `UPDATE users SET branch_id = $2 WHERE id = $1 AND deleted_at IS NULL`,
    [user_id, branch_id ?? null],
  );
};

// Adopt every branch-less, non-super_admin user into a branch. super_admin
// spans all branches so is intentionally excluded. Runs on a tx client so the
// whole adopt-all operation is atomic. Returns the number of users moved.
export const adoptUnbranchedUsers = async (client, branch_id) => {
  const { rowCount } = await client.query(
    `UPDATE users
        SET branch_id = $1
      WHERE branch_id IS NULL
        AND deleted_at IS NULL
        AND role <> 'super_admin'`,
    [branch_id],
  );
  return rowCount;
};

export const getUpdatedAt = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT updated_at FROM branches WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0]?.updated_at ?? null;
};
