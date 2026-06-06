import { QUEUE_NAMES } from '../config/constants.js';
import { sysQuery } from '../db/system.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { publish } from '../lib/queue.js';
import { nextBusinessMoment } from '../modules/calendar/repo.js';
import { logger } from '../lib/logger.js';

// Automated WhatsApp is disabled (per-user manual chat only). No whatsapp queue.
const channelQueue = { email: QUEUE_NAMES.EMAIL, sms: QUEUE_NAMES.SMS };

const tick = async () => {
  try {
    const { rows: tenants } = await sysQuery(`SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL`);
    for (const { id } of tenants) {
      const tenant = await resolveTenantById(id);
      if (!tenant) continue;
      const { rows: due } = await tenantQuery(
        tenant,
        `SELECT * FROM scheduled_sends WHERE status = 'scheduled' AND scheduled_for <= now() AND deleted_at IS NULL LIMIT 50`,
      );
      for (const s of due) {
        // WhatsApp scheduled sends are disabled — mark skipped, no automated WA.
        if (s.channel === 'whatsapp') {
          await tenantQuery(tenant, `UPDATE scheduled_sends SET status = 'completed' WHERE id = $1`, [s.id]);
          logger.info({ scheduled_send_id: s.id }, 'scheduled WhatsApp send skipped (automated WA disabled)');
          continue;
        }
        await tenantQuery(tenant, `UPDATE scheduled_sends SET status = 'running' WHERE id = $1`, [s.id]);
        for (const lead_id of s.lead_ids) {
          const { rows: [lead] } = await tenantQuery(tenant, `SELECT email, phone, whatsapp_number FROM leads WHERE id = $1 AND deleted_at IS NULL`, [lead_id]);
          if (!lead) continue;
          const recipField = s.channel === 'email' ? 'email' : s.channel === 'whatsapp' ? 'whatsapp_number' : 'phone';
          const recipient = lead[recipField];
          if (!recipient) continue;
          const { rows: [log] } = await tenantQuery(
            tenant,
            `INSERT INTO message_log (lead_id, user_id, channel, template_id, recipient, provider, status, scheduled_send_id)
             VALUES ($1,$2,$3,$4,$5,$6,'queued',$7) RETURNING id`,
            [lead_id, s.user_id, s.channel, s.template_id, recipient, s.channel === 'email' ? 'brevo' : s.channel === 'sms' ? 'messagecentral' : 'wabridge', s.id],
          );
          await publish(channelQueue[s.channel], 'send', {
            tenantId: tenant.id,
            message_log_id: log.id,
            lead_id,
            template_id: s.template_id,
            variable_overrides: s.variable_overrides_json ?? {},
          });
        }
        await tenantQuery(tenant, `UPDATE scheduled_sends SET status = 'completed' WHERE id = $1`, [s.id]);
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'scheduled-send-runner tick failed');
  }
};

setInterval(tick, 60_000);
setTimeout(tick, 5_000);
