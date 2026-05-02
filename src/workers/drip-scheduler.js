import { QUEUE_NAMES } from '../config/constants.js';
import { sysQuery } from '../db/system.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { publish } from '../lib/queue.js';
import { evaluateCondition } from '../services/rule-engine.js';
import { logger } from '../lib/logger.js';

const channelQueue = { email: QUEUE_NAMES.EMAIL, sms: QUEUE_NAMES.SMS, whatsapp: QUEUE_NAMES.WHATSAPP };

const tick = async () => {
  try {
    const { rows: tenants } = await sysQuery(`SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL`);
    for (const { id } of tenants) {
      const tenant = await resolveTenantById(id);
      if (!tenant) continue;
      const { rows: drips } = await tenantQuery(tenant, `SELECT * FROM campaigns_drip WHERE active = true AND deleted_at IS NULL`);
      for (const drip of drips) {
        const { rows: rules } = await tenantQuery(tenant, `SELECT * FROM campaigns_drip_rules WHERE drip_id = $1 ORDER BY step_order`, [drip.id]);
        for (const rule of rules) {
          // Find leads that entered eligibility `day_offset` days ago and haven't run this step yet.
          const { rows: eligible } = await tenantQuery(
            tenant,
            `SELECT l.* FROM leads l
              WHERE l.deleted_at IS NULL
                AND DATE(l.created_at) = DATE(now()) - INTERVAL '${Number(rule.day_offset)} days'
                AND NOT EXISTS (SELECT 1 FROM campaigns_drip_runs r WHERE r.drip_id = $1 AND r.lead_id = l.id AND r.step_id = $2)`,
            [drip.id, rule.id],
          );
          for (const lead of eligible) {
            if (rule.condition_json && Object.keys(rule.condition_json).length) {
              if (!evaluateCondition(rule.condition_json, { lead })) continue;
            }
            const recipField = rule.channel === 'email' ? 'email' : rule.channel === 'whatsapp' ? 'whatsapp_number' : 'phone';
            const recipient = lead[recipField] ?? lead.phone;
            if (!recipient) continue;
            const { rows: [log] } = await tenantQuery(
              tenant,
              `INSERT INTO message_log (lead_id, channel, template_id, recipient, provider, status, campaign_id)
               VALUES ($1,$2,$3,$4,$5,'queued',NULL) RETURNING id`,
              [lead.id, rule.channel, rule.template_id, recipient, rule.channel === 'email' ? 'brevo' : rule.channel === 'sms' ? 'messagecentral' : 'wabridge'],
            );
            await tenantQuery(
              tenant,
              `INSERT INTO campaigns_drip_runs (drip_id, lead_id, step_id, status, message_log_id) VALUES ($1,$2,$3,'queued',$4)`,
              [drip.id, lead.id, rule.id, log.id],
            );
            await publish(channelQueue[rule.channel], 'send', { tenantId: tenant.id, message_log_id: log.id, lead_id: lead.id, template_id: rule.template_id });
          }
        }
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'drip-scheduler tick failed');
  }
};

// Run every 5 minutes
setInterval(tick, 5 * 60_000);
// Kick off once on startup
setTimeout(tick, 10_000);
