import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES } from '../config/constants.js';
import { sendSms } from '../lib/providers/sms-messagecentral.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { render, buildContext } from '../lib/templating.js';
import { logger } from '../lib/logger.js';

registerWorker(QUEUE_NAMES.SMS, async ({ data }) => {
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;
  const { rows: [msg] } = await tenantQuery(tenant, `SELECT * FROM message_log WHERE id = $1`, [data.message_log_id]);
  if (!msg) return;
  const { rows: [tpl] } = await tenantQuery(tenant, `SELECT * FROM sms_templates WHERE id = $1`, [msg.template_id]);
  const { rows: [lead] } = await tenantQuery(tenant, `SELECT * FROM leads WHERE id = $1`, [msg.lead_id]);
  const { rows: [user] } = await tenantQuery(tenant, `SELECT * FROM users WHERE id = $1`, [msg.user_id]);
  const context = buildContext({ lead, counsellor: user, tenant, extra: data.variable_overrides });
  try {
    const body = render(tpl.body, context).rendered;
    const resp = await sendSms({ to: msg.recipient, body, dlt_template_id: tpl.dlt_template_id, dlt_entity_id: tpl.dlt_entity_id });
    await tenantQuery(tenant, `UPDATE message_log SET status = 'sent', sent_at = now(), provider_message_id = $2 WHERE id = $1`, [msg.id, resp.provider_message_id]);
  } catch (err) {
    logger.error({ err: err.message, id: msg.id }, 'sms send failed');
    await tenantQuery(tenant, `UPDATE message_log SET status = 'failed', failed_at = now(), error = $2 WHERE id = $1`, [msg.id, err.message]);
  }
}, { concurrency: 8, jobName: 'send' });
