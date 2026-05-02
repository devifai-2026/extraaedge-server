import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES } from '../config/constants.js';
import { sysQuery } from '../db/system.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { hmac } from '../lib/crypto.js';
import { logger } from '../lib/logger.js';

// Fan out every event to matching outbound webhook subscribers.
registerWorker(QUEUE_NAMES.EVENTS, async ({ data }) => {
  try {
    const tenant = await resolveTenantById(data.tenantId);
    if (!tenant) return;
    const { rows: hooks } = await tenantQuery(
      tenant,
      `SELECT * FROM outbound_webhooks WHERE is_active = true AND deleted_at IS NULL AND $1 = ANY(event_types)`,
      [data.type],
    );
    for (const h of hooks) {
      const body = JSON.stringify(data);
      const signature = hmac(h.secret, body);
      await tenantQuery(
        tenant,
        `INSERT INTO outbound_webhook_deliveries (webhook_id, event_id, event_type, payload_json, signature, status, scheduled_for)
         VALUES ($1, gen_random_uuid(), $2, $3::jsonb, $4, 'pending', now())`,
        [h.id, data.type, body, signature],
      );
    }
  } catch (err) {
    logger.error({ err: err.message }, 'outbound-webhook-dispatcher failed');
  }
}, { concurrency: 4, jobName: '*' });

// Deliverer ticks periodically and flushes pending deliveries.
const deliver = async () => {
  try {
    const { rows: tenants } = await sysQuery(`SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL`);
    for (const { id } of tenants) {
      const tenant = await resolveTenantById(id);
      if (!tenant) continue;
      const { rows: pending } = await tenantQuery(
        tenant,
        `SELECT d.*, w.target_url, w.secret, w.custom_headers_json, w.retry_config_json
           FROM outbound_webhook_deliveries d
           JOIN outbound_webhooks w ON w.id = d.webhook_id
          WHERE d.status IN ('pending','failed')
            AND (d.next_retry_at IS NULL OR d.next_retry_at <= now())
            AND (d.scheduled_for IS NULL OR d.scheduled_for <= now())
          ORDER BY d.created_at LIMIT 100`,
      );
      for (const d of pending) {
        const headers = { 'Content-Type': 'application/json', 'X-Signature': d.signature, ...(d.custom_headers_json ?? {}) };
        try {
          const res = await fetch(d.target_url, { method: 'POST', headers, body: JSON.stringify(d.payload_json) });
          const bodyText = await res.text();
          if (res.ok) {
            await tenantQuery(tenant, `UPDATE outbound_webhook_deliveries SET status = 'delivered', delivered_at = now(), response_code = $2, response_body = $3, attempt = attempt + 1 WHERE id = $1`, [d.id, res.status, bodyText.slice(0, 2000)]);
          } else {
            const cfg = d.retry_config_json ?? { max: 5, backoff_ms: [30000, 120000, 600000, 3600000, 21600000] };
            const attempt = d.attempt + 1;
            const dead = attempt >= cfg.max;
            const nextMs = dead ? null : (cfg.backoff_ms[Math.min(attempt - 1, cfg.backoff_ms.length - 1)] ?? 60000);
            await tenantQuery(
              tenant,
              `UPDATE outbound_webhook_deliveries SET status = $2, attempt = $3, response_code = $4, response_body = $5, next_retry_at = $6, failed_at = now() WHERE id = $1`,
              [d.id, dead ? 'dead' : 'failed', attempt, res.status, bodyText.slice(0, 2000), nextMs ? new Date(Date.now() + nextMs) : null],
            );
          }
        } catch (err) {
          await tenantQuery(tenant, `UPDATE outbound_webhook_deliveries SET status = 'failed', attempt = attempt + 1, response_body = $2, next_retry_at = now() + interval '1 minute', failed_at = now() WHERE id = $1`, [d.id, err.message.slice(0, 500)]);
        }
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'outbound-webhook deliver tick failed');
  }
};
setInterval(deliver, 30_000);
setTimeout(deliver, 10_000);
