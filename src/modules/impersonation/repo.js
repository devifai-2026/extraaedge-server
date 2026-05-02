import { sysQuery } from '../../db/system.js';

export const startSession = async ({ platform_user_id, tenant_id, tenant_user_id, tenant_user_email, reason, read_only, ip, user_agent }) => {
  const { rows } = await sysQuery(
    `INSERT INTO impersonation_sessions (platform_user_id, tenant_id, tenant_user_id, tenant_user_email, reason, read_only, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [platform_user_id, tenant_id, tenant_user_id, tenant_user_email, reason, read_only, ip, user_agent],
  );
  return rows[0];
};

export const endSession = async (id) => {
  const { rows } = await sysQuery(
    `UPDATE impersonation_sessions SET ended_at = now() WHERE id = $1 AND ended_at IS NULL RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
};

export const findById = async (id) => {
  const { rows } = await sysQuery(`SELECT * FROM impersonation_sessions WHERE id = $1`, [id]);
  return rows[0] ?? null;
};

export const list = async ({ tenant_id, platform_user_id, active, page, limit }) => {
  const conds = [];
  const params = [];
  if (tenant_id) { params.push(tenant_id); conds.push(`tenant_id = $${params.length}`); }
  if (platform_user_id) { params.push(platform_user_id); conds.push(`platform_user_id = $${params.length}`); }
  if (active === 'true') conds.push('ended_at IS NULL');
  if (active === 'false') conds.push('ended_at IS NOT NULL');
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const { rows } = await sysQuery(
    `SELECT * FROM impersonation_sessions ${where} ORDER BY started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
};
