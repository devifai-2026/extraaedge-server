import { sysQuery } from '../db/system.js';

export const recordPlatformAudit = async ({
  platform_user_id,
  action,
  entity_type = null,
  entity_id = null,
  tenant_id = null,
  before_json = null,
  after_json = null,
  ip = null,
  user_agent = null,
}) => {
  await sysQuery(
    `INSERT INTO platform_audit_log (platform_user_id, action, entity_type, entity_id, tenant_id, before_json, after_json, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [platform_user_id, action, entity_type, entity_id, tenant_id, before_json, after_json, ip, user_agent],
  );
};

export const listPlatformAudit = async ({ page = 1, limit = 50, tenant_id, platform_user_id, action }) => {
  const conds = [];
  const params = [];
  if (tenant_id) {
    params.push(tenant_id);
    conds.push(`tenant_id = $${params.length}`);
  }
  if (platform_user_id) {
    params.push(platform_user_id);
    conds.push(`platform_user_id = $${params.length}`);
  }
  if (action) {
    params.push(action);
    conds.push(`action = $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const { rows } = await sysQuery(
    `SELECT * FROM platform_audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows;
};
