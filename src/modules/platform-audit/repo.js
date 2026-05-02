// Platform audit log persistence. SQL only, no business logic.
import { sysQuery } from '../../db/system.js';
import { selectMany, selectCount, whereBuilder, buildPagination } from '../../lib/dbHelpers.js';

const SELECT_COLUMNS = `
  a.id, a.action, a.entity_type, a.entity_id, a.tenant_id, a.created_at,
  pu.email AS platform_user_email,
  t.slug   AS tenant_slug
`;

const FROM_JOIN = `
  FROM platform_audit_log a
  LEFT JOIN platform_users pu ON pu.id = a.platform_user_id
  LEFT JOIN tenants t        ON t.id  = a.tenant_id
`;

/**
 * @param {{ action?: string, entity_type?: string, tenant_id?: string,
 *           platform_user_id?: string, page?: number, limit?: number }} filter
 */
export const listAndCount = async (filter = {}) => {
  const wb = whereBuilder();
  wb.add(filter.action,           (_, i) => `a.action = $${i}`);
  wb.add(filter.entity_type,      (_, i) => `a.entity_type = $${i}`);
  wb.add(filter.tenant_id,        (_, i) => `a.tenant_id = $${i}`);
  wb.add(filter.platform_user_id, (_, i) => `a.platform_user_id = $${i}`);

  const totalSql = `SELECT count(*)::int AS count ${FROM_JOIN} ${wb.sql}`;
  const total = await selectCount(sysQuery, totalSql, wb.params);

  const pg = buildPagination(filter.page, filter.limit, wb.params.length);
  const listSql = `SELECT ${SELECT_COLUMNS} ${FROM_JOIN} ${wb.sql}
                   ORDER BY a.created_at DESC
                   ${pg.limitClause}`;
  const rows = await selectMany(sysQuery, listSql, [...wb.params, ...pg.params]);

  return { rows, total, page: pg.page, limit: pg.limit };
};
