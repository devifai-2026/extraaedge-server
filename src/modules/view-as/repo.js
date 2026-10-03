import { tenantQuery } from '../../db/tenant.js';

// view_as_sessions lives in the TENANT database, unlike the platform's
// impersonation_sessions (system DB, platform_user_id NOT NULL referencing
// platform_users). A branch manager has no platform_users row, so that table
// could not hold these rows even if we wanted one audit trail for both.
export const startSession = async (tenant, {
  actor_user_id, target_user_id, target_user_email, reason, ip, user_agent,
}) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO view_as_sessions
       (actor_user_id, target_user_id, target_user_email, reason, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [actor_user_id, target_user_id, target_user_email, reason, ip, user_agent],
  );
  return rows[0];
};

// Ending is idempotent and scoped to the actor: the WHERE clause means a
// branch manager can only close their own session, and closing an
// already-closed one is a no-op rather than an error.
export const endSession = async (tenant, id, actor_user_id) => {
  const { rows } = await tenantQuery(
    tenant,
    `UPDATE view_as_sessions
        SET ended_at = now()
      WHERE id = $1 AND actor_user_id = $2 AND ended_at IS NULL
      RETURNING *`,
    [id, actor_user_id],
  );
  return rows[0] ?? null;
};

export const list = async (tenant, { actor_user_id, target_user_id, active, page, limit }) => {
  const conds = [];
  const params = [];
  if (actor_user_id) { params.push(actor_user_id); conds.push(`s.actor_user_id = $${params.length}`); }
  if (target_user_id) { params.push(target_user_id); conds.push(`s.target_user_id = $${params.length}`); }
  if (active === 'true') conds.push('s.ended_at IS NULL');
  if (active === 'false') conds.push('s.ended_at IS NOT NULL');
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  params.push(limit);
  params.push((page - 1) * limit);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT s.*, a.name AS actor_name, t.name AS target_name, t.role AS target_role
       FROM view_as_sessions s
       LEFT JOIN users a ON a.id = s.actor_user_id
       LEFT JOIN users t ON t.id = s.target_user_id
       ${where}
      ORDER BY s.started_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const { rows: [count] } = await tenantQuery(
    tenant,
    `SELECT count(*)::int AS total FROM view_as_sessions s ${where}`,
    params.slice(0, params.length - 2),
  );
  return { rows, total: count?.total ?? 0 };
};
