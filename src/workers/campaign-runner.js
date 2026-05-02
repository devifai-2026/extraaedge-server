import { registerWorker, publish } from '../lib/queue.js';
import { QUEUE_NAMES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { logger } from '../lib/logger.js';

const channelQueue = { email: QUEUE_NAMES.EMAIL, sms: QUEUE_NAMES.SMS, whatsapp: QUEUE_NAMES.WHATSAPP };

registerWorker(QUEUE_NAMES.CAMPAIGN, async ({ data }) => {
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;
  try {
    const { rows: [c] } = await tenantQuery(tenant, `SELECT * FROM campaigns_bulk WHERE id = $1`, [data.campaign_id]);
    if (!c || c.stage !== 'IN_PROGRESS') return;

    const filter = c.audience_filter_json ?? {};
    const conds = ['deleted_at IS NULL'];
    const params = [];
    if (filter.stage_ids) { params.push(filter.stage_ids); conds.push(`stage_id = ANY($${params.length}::uuid[])`); }
    if (filter.program_ids) { params.push(filter.program_ids); conds.push(`program_id = ANY($${params.length}::uuid[])`); }
    if (filter.assigned_to) { params.push(filter.assigned_to); conds.push(`assigned_to = ANY($${params.length}::uuid[])`); }
    const { rows: leads } = await tenantQuery(tenant, `SELECT id, email, phone, whatsapp_number FROM leads WHERE ${conds.join(' AND ')}`, params);

    await tenantQuery(tenant, `UPDATE campaigns_bulk_stats SET leads_count = $2 WHERE campaign_id = $1`, [c.id, leads.length]);

    const channels = c.channel === 'multi' ? ['email', 'sms', 'whatsapp'] : [c.channel];
    for (const ch of channels) {
      const tplField = ch === 'email' ? c.email_template_id : ch === 'sms' ? c.sms_template_id : c.whatsapp_template_id;
      if (!tplField) continue;
      const recipField = ch === 'email' ? 'email' : ch === 'whatsapp' ? 'whatsapp_number' : 'phone';
      let triggered = 0;
      for (const l of leads) {
        const recipient = l[recipField] ?? l.phone;
        if (!recipient) continue;
        const { rows } = await tenantQuery(
          tenant,
          `INSERT INTO message_log (lead_id, channel, template_id, recipient, provider, status, campaign_id)
           VALUES ($1,$2,$3,$4,$5,'queued',$6) RETURNING id`,
          [l.id, ch, tplField, recipient, ch === 'email' ? 'brevo' : ch === 'sms' ? 'messagecentral' : 'wabridge', c.id],
        );
        await publish(channelQueue[ch], 'send', { tenantId: tenant.id, message_log_id: rows[0].id, lead_id: l.id, template_id: tplField });
        triggered += 1;
      }
      await tenantQuery(tenant, `UPDATE campaigns_bulk_stats SET ${ch === 'email' ? 'email_triggered' : ch === 'sms' ? 'sms_triggered' : 'wa_triggered'} = ${ch === 'email' ? 'email_triggered' : ch === 'sms' ? 'sms_triggered' : 'wa_triggered'} + $2 WHERE campaign_id = $1`, [c.id, triggered]);
    }

    await tenantQuery(tenant, `UPDATE campaigns_bulk SET stage = 'COMPLETED', completed_at = now() WHERE id = $1`, [c.id]);
  } catch (err) {
    logger.error({ err: err.message, campaign_id: data.campaign_id }, 'campaign-runner failed');
    await tenantQuery(tenant, `UPDATE campaigns_bulk SET stage = 'STOPPED' WHERE id = $1`, [data.campaign_id]);
  }
}, { concurrency: 1, jobName: 'run' });
