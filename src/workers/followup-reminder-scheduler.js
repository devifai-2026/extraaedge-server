import { sysQuery } from '../db/system.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { pushNotification } from '../modules/notifications/service.js';
import { logger } from '../lib/logger.js';

const tick = async () => {
  try {
    const { rows: tenants } = await sysQuery(`SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL`);
    for (const { id } of tenants) {
      const tenant = await resolveTenantById(id);
      if (!tenant) continue;
      // Follow-ups due in the next 15 minutes, not yet reminded
      const { rows: due } = await tenantQuery(
        tenant,
        `SELECT f.id, f.lead_id, f.created_by, f.next_action_datetime, l.assigned_to, l.name AS lead_name
           FROM lead_followups f LEFT JOIN leads l ON l.id = f.lead_id
          WHERE f.deleted_at IS NULL AND f.status = 'planned' AND f.reminder_sent_at IS NULL
            AND f.next_action_datetime BETWEEN now() AND now() + interval '15 minutes'
          LIMIT 500`,
      );
      for (const f of due) {
        const recipients = new Set([f.created_by, f.assigned_to].filter(Boolean));
        for (const uid of recipients) {
          await pushNotification(tenant, {
            user_id: uid,
            type: 'follow_up_reminder',
            message: `Follow-up for ${f.lead_name ?? 'a lead'} is due in 15 minutes`,
            metadata_json: { follow_up_id: f.id, lead_id: f.lead_id, at: f.next_action_datetime },
            link: `/leads/${f.lead_id}`,
          });
        }
        await tenantQuery(tenant, `UPDATE lead_followups SET reminder_sent_at = now() WHERE id = $1`, [f.id]);
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'followup-reminder tick failed');
  }
};
setInterval(tick, 60_000);
setTimeout(tick, 5_000);
