import { tenantQuery } from '../../db/tenant.js';

const COLS = 'id, name, description, manager_id, parent_team_id, created_at, updated_at';

export const list = async (tenant) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS},
            (SELECT count(*)::int FROM team_members tm WHERE tm.team_id = t.id) AS member_count
       FROM teams t
       WHERE deleted_at IS NULL
       ORDER BY name`,
  );
  return rows;
};

export const findById = async (tenant, id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT ${COLS} FROM teams WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return rows[0] ?? null;
};

export const insert = async (tenant, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO teams (name, description, manager_id, parent_team_id)
     VALUES ($1,$2,$3,$4) RETURNING ${COLS}`,
    [input.name, input.description ?? null, input.manager_id ?? null, input.parent_team_id ?? null],
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
    `UPDATE teams SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING ${COLS}`,
    params,
  );
  return rows[0] ?? null;
};

export const softDelete = async (tenant, id) => {
  await tenantQuery(tenant, `UPDATE teams SET deleted_at = now() WHERE id = $1`, [id]);
};

export const addMember = async (tenant, team_id, user_id) => {
  await tenantQuery(
    tenant,
    `INSERT INTO team_members (team_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [team_id, user_id],
  );
  await tenantQuery(tenant, `UPDATE users SET team_id = $2 WHERE id = $1`, [user_id, team_id]);
};

export const removeMember = async (tenant, team_id, user_id) => {
  await tenantQuery(tenant, `DELETE FROM team_members WHERE team_id = $1 AND user_id = $2`, [team_id, user_id]);
  await tenantQuery(tenant, `UPDATE users SET team_id = NULL WHERE id = $1 AND team_id = $2`, [user_id, team_id]);
};

export const listMembers = async (tenant, team_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT u.id, u.name, u.email, u.role, u.role_id, u.phone, tm.joined_at
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = $1 AND u.deleted_at IS NULL
      ORDER BY tm.joined_at`,
    [team_id],
  );
  return rows;
};

export const listLeads = async (tenant, team_id, { page = 1, limit = 50 } = {}) => {
  const offset = (page - 1) * limit;
  const { rows } = await tenantQuery(
    tenant,
    `SELECT l.id, l.name, l.email, l.phone, l.stage_id, l.assigned_to, l.lead_score, l.created_at
       FROM leads l
      WHERE l.team_id = $1 AND l.deleted_at IS NULL
      ORDER BY l.created_at DESC
      LIMIT $2 OFFSET $3`,
    [team_id, limit, offset],
  );
  return rows;
};

export const getUpdatedAt = async (tenant, id) => {
  const { rows } = await tenantQuery(tenant, `SELECT updated_at FROM teams WHERE id = $1 AND deleted_at IS NULL`, [id]);
  return rows[0]?.updated_at ?? null;
};
