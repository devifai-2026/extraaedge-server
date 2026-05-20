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
      // No grace period: as soon as the scheduled time passes, a still-
      // planned row flips to 'missed' so the FollowupManager card shows
      // the red-dot 'missed' state and the counsellor can reschedule /
      // mark done / cancel. The scanner tick is every 5 minutes, so the
      // worst-case delay is ~5 minutes after the due time.
      const { rows: missed } = await tenantQuery(
        tenant,
        `UPDATE lead_followups
            SET status = 'missed'
          WHERE deleted_at IS NULL AND status = 'planned' AND next_action_datetime < now()
          RETURNING id, lead_id, created_by`,
      );
      for (const m of missed) {
        // Notify creator + current lead owner
        const { rows: leadRows } = await tenantQuery(tenant, `SELECT assigned_to FROM leads WHERE id = $1`, [m.lead_id]);
        const recipients = new Set([m.created_by, leadRows[0]?.assigned_to].filter(Boolean));
        for (const uid of recipients) {
          await pushNotification(tenant, {
            user_id: uid,
            type: 'follow_up_missed',
            message: 'A scheduled follow-up was missed',
            metadata_json: { follow_up_id: m.id, lead_id: m.lead_id },
            link: `/leads/${m.lead_id}`,
          });
        }
        await tenantQuery(tenant, `INSERT INTO lead_activities (lead_id, type, summary) VALUES ($1,'follow_up_missed','Follow-up missed')`, [m.lead_id]);
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'missed-followup tick failed');
  }
};
setInterval(tick, 5 * 60_000);
setTimeout(tick, 30_000);
