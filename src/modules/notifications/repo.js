import { tenantQuery } from '../../db/tenant.js';

export const list = async (tenant, user_id, { unread_only, page, limit }) => {
  const conds = ['user_id = $1'];
  const params = [user_id];
  if (unread_only === 'true') conds.push('is_read = false');
  const where = `WHERE ${conds.join(' AND ')}`;
  const offset = (page - 1) * limit;
  params.push(limit, offset);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT * FROM notifications ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const { rows: unreadCount } = await tenantQuery(
    tenant,
    `SELECT count(*)::int AS unread FROM notifications WHERE user_id = $1 AND is_read = false`,
    [user_id],
  );
  return { rows, unread: unreadCount[0].unread };
};

export const insert = async (tenant, input) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO notifications (user_id, type, message, metadata_json, link)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [input.user_id, input.type, input.message, input.metadata_json ?? null, input.link ?? null],
  );
  return rows[0];
};

export const markRead = async (tenant, user_id, id) => {
  await tenantQuery(tenant, `UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2`, [id, user_id]);
};

export const markAllRead = async (tenant, user_id) => {
  await tenantQuery(tenant, `UPDATE notifications SET is_read = true WHERE user_id = $1 AND is_read = false`, [user_id]);
};

// Hard-delete every notification row for this user. Triggered from the
// "Delete all" button in the bell popover (Live tab). Notification rows
// are append-only audit, so wiping a user's own copy is safe — the
// underlying lead activity row is untouched.
export const deleteAll = async (tenant, user_id) => {
  await tenantQuery(tenant, `DELETE FROM notifications WHERE user_id = $1`, [user_id]);
};
