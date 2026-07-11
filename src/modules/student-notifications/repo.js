import { tenantQuery } from '../../db/tenant.js';

export const insert = async (tenant, { student_id, type, message, link, metadata }) => {
  const { rows } = await tenantQuery(
    tenant,
    `INSERT INTO student_notifications (student_id, type, message, link, metadata)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [student_id, type, message, link ?? null, metadata ? JSON.stringify(metadata) : null],
  );
  return rows[0];
};

export const list = async (tenant, studentId, { unreadOnly, limit = 30 } = {}) => {
  const conds = ['student_id = $1'];
  const params = [studentId];
  if (unreadOnly) conds.push('is_read = false');
  params.push(limit);
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id, type, message, link, metadata, is_read, created_at
       FROM student_notifications WHERE ${conds.join(' AND ')}
      ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows;
};

export const unreadCount = async (tenant, studentId) => {
  const { rows } = await tenantQuery(
    tenant,
    `SELECT count(*)::int AS n FROM student_notifications WHERE student_id = $1 AND is_read = false`,
    [studentId],
  );
  return rows[0]?.n || 0;
};

export const markRead = async (tenant, studentId, id) => {
  await tenantQuery(tenant, `UPDATE student_notifications SET is_read = true WHERE id = $1 AND student_id = $2`, [id, studentId]);
};

export const markAllRead = async (tenant, studentId) => {
  await tenantQuery(tenant, `UPDATE student_notifications SET is_read = true WHERE student_id = $1 AND is_read = false`, [studentId]);
};

// Active student ids in a batch (fan-out target for announcements). If batchId
// is null (course-wide announcement), returns all active students of the
// program instead.
export const audienceForBatch = async (tenant, { programId, batchId }) => {
  if (batchId) {
    const { rows } = await tenantQuery(
      tenant,
      `SELECT bs.student_id FROM batch_students bs JOIN students s ON s.id = bs.student_id
        WHERE bs.batch_id = $1 AND bs.deleted_at IS NULL AND s.deleted_at IS NULL AND s.status = 'active'`,
      [batchId],
    );
    return rows.map((r) => r.student_id);
  }
  const { rows } = await tenantQuery(
    tenant,
    `SELECT id FROM students WHERE program_id = $1 AND deleted_at IS NULL AND status = 'active'`,
    [programId],
  );
  return rows.map((r) => r.id);
};
