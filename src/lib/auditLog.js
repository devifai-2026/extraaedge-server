import { tenantQuery } from '../db/tenant.js';
import { logger } from './logger.js';

// The audit_log table (db/migrations/tenant/1700000004000_ops.cjs) existed
// with zero writers until the lead-protection feature — this is the shared
// writer every future one should reuse rather than inlining its own INSERT.
// Fire-and-forget: a logging failure must never break the request being
// audited, but it's still worth knowing about, hence the error log.
export const writeAuditLog = async (tenant, { userId, action, entityType, entityId, ip, userAgent, beforeJson, afterJson } = {}) => {
  try {
    await tenantQuery(
      tenant,
      `INSERT INTO audit_log (user_id, action, entity_type, entity_id, ip, user_agent, before_json, after_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId ?? null, action, entityType ?? null, entityId ?? null, ip ?? null, userAgent ?? null, beforeJson ?? null, afterJson ?? null],
    );
  } catch (err) {
    logger.error({ err: err.message, action, entityType, entityId }, 'writeAuditLog failed');
  }
};
