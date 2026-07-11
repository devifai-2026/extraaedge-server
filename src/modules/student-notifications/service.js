// Student notifications — persist + live socket push. The single entry point
// (pushStudentNotification) is called from the LMS flows a student cares about;
// best-effort so it never blocks the triggering action.
import * as repo from './repo.js';
import { notifyStudent } from '../../lib/socket.js';
import { logger } from '../../lib/logger.js';

export const pushStudentNotification = async (tenant, studentId, { type, message, link, metadata } = {}) => {
  if (!tenant || !studentId || !type || !message) return null;
  try {
    const row = await repo.insert(tenant, { student_id: studentId, type, message, link, metadata });
    // Live push (student's socket room). Payload mirrors the persisted row.
    notifyStudent(tenant.id, studentId, `student.${type}`, { id: row.id, message, link, type });
    return row;
  } catch (err) {
    logger.error({ err: err.message, studentId, type }, 'pushStudentNotification failed');
    return null;
  }
};

// Fan a notification out to every active student in a batch (or program-wide
// when batchId is null) — used for announcements / recording uploads.
export const notifyBatch = async (tenant, { programId, batchId }, payload) => {
  try {
    const ids = await repo.audienceForBatch(tenant, { programId, batchId });
    await Promise.all(ids.map((sid) => pushStudentNotification(tenant, sid, payload)));
  } catch (err) {
    logger.error({ err: err.message, programId, batchId }, 'notifyBatch failed');
  }
};

export const list = (tenant, studentId, opts) => repo.list(tenant, studentId, opts);
export const unreadCount = (tenant, studentId) => repo.unreadCount(tenant, studentId);
export const markRead = (tenant, studentId, id) => repo.markRead(tenant, studentId, id);
export const markAllRead = (tenant, studentId) => repo.markAllRead(tenant, studentId);
