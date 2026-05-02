import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES } from '../config/constants.js';
import { sendTemplate, sendSessionMessage } from '../lib/providers/whatsapp-wabridge.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { logger } from '../lib/logger.js';

registerWorker(QUEUE_NAMES.WHATSAPP, async ({ data }) => {
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;
  const { rows: [msg] } = await tenantQuery(tenant, `SELECT * FROM message_log WHERE id = $1`, [data.message_log_id]);
  if (!msg) return;
  const { rows: [tpl] } = await tenantQuery(tenant, `SELECT * FROM whatsapp_templates WHERE id = $1`, [msg.template_id]);
  try {
    // Build components from variables in variable_overrides — WABridge accepts text substitutions.
    const components = (tpl.variables ?? []).length
      ? [{ type: 'body', parameters: (tpl.variables ?? []).map((key) => ({ type: 'text', text: String((data.variable_overrides ?? {})[key] ?? '') })) }]
      : [];
    const resp = await sendTemplate({ to: msg.recipient, template_name: tpl.wabridge_template_name, language: tpl.language, components });
    await tenantQuery(tenant, `UPDATE message_log SET status = 'sent', sent_at = now(), provider_message_id = $2 WHERE id = $1`, [msg.id, resp.provider_message_id]);
  } catch (err) {
    logger.error({ err: err.message, id: msg.id }, 'wa send failed');
    await tenantQuery(tenant, `UPDATE message_log SET status = 'failed', failed_at = now(), error = $2 WHERE id = $1`, [msg.id, err.message]);
  }
}, { concurrency: 4, jobName: 'send' });
