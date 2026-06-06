// Persistence for the cross-tenant API activity log (platform_request_log).
// Writes are called fire-and-forget by middleware/requestLog.js; reads back
// the product_owner "Danger Request Log".
import { sysQuery } from '../db/system.js';

export const recordRequest = async (e) => {
  await sysQuery(
    `INSERT INTO platform_request_log (
       request_id, actor_user_id, actor_email, actor_role, is_platform_actor,
       tenant_id, tenant_slug, method, path, route, query_json, status_code,
       duration_ms, request_body, response_body, request_body_text,
       response_body_text, body_truncated, is_error, error_code, error_message,
       category, ip, user_agent
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,
       $14::jsonb,$15::jsonb,$16,$17,$18,$19,$20,$21,$22,$23,$24
     )`,
    [
      e.request_id, e.actor_user_id, e.actor_email, e.actor_role, e.is_platform_actor,
      e.tenant_id, e.tenant_slug, e.method, e.path, e.route,
      e.query_json ? JSON.stringify(e.query_json) : null, e.status_code,
      e.duration_ms,
      e.request_body ? JSON.stringify(e.request_body) : null,
      e.response_body ? JSON.stringify(e.response_body) : null,
      e.request_body_text, e.response_body_text, e.body_truncated,
      e.is_error, e.error_code, e.error_message, e.category, e.ip, e.user_agent,
    ],
  );
};
