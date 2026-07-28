// Raw WhatsApp payload logging (inbound + outbound) for the PO console
// Webhooks tab. Best-effort + fire-and-forget: a logging failure must never
// break message send/receive. Pruned to the last 30 days on each write (cheap:
// one indexed DELETE, only fires occasionally in practice).
import { tenantQuery } from '../../../db/tenant.js';
import { logger } from '../../../lib/logger.js';

const RETENTION_DAYS = 30;

// Trim a value to safe JSON (guards against circular / huge blobs).
const safeJson = (v) => {
  if (v == null) return null;
  try { return JSON.stringify(v); } catch { return JSON.stringify(String(v)); }
};

export const logWaWebhook = async (tenant, {
  direction, event = null, endpoint = null, phone = null,
  statusCode = null, ok = null, request = null, response = null, error = null,
}) => {
  try {
    await tenantQuery(
      tenant,
      `INSERT INTO wa_webhook_logs
         (direction, event, endpoint, phone, status_code, ok, request_json, response_json, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
      [direction, event, endpoint, phone, statusCode, ok, safeJson(request), safeJson(response), error],
    );
    // Opportunistic prune (30-day retention). Errors here are non-fatal.
    await tenantQuery(
      tenant,
      `DELETE FROM wa_webhook_logs WHERE created_at < now() - interval '${RETENTION_DAYS} days'`,
    ).catch(() => {});
  } catch (err) {
    logger.warn({ tenantId: tenant?.id, err: err.message }, 'wa webhook log write failed');
  }
};
