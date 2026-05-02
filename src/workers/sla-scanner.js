import { sysQuery } from '../db/system.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { pushNotification } from '../modules/notifications/service.js';
import { evaluateCondition } from '../services/rule-engine.js';
import { logger } from '../lib/logger.js';

const tick = async () => {
  try {
    const { rows: tenants } = await sysQuery(`SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL`);
    for (const { id } of tenants) {
      const tenant = await resolveTenantById(id);
      if (!tenant) continue;
      const { rows: policies } = await tenantQuery(tenant, `SELECT * FROM sla_policies WHERE is_active AND deleted_at IS NULL`);
      for (const p of policies) {
        // Flag stale leads
        const { rows: stale } = await tenantQuery(
          tenant,
          `SELECT id, assigned_to FROM leads
            WHERE deleted_at IS NULL
              AND last_activity_at < now() - ($1 * interval '1 hour')
              AND NOT EXISTS (SELECT 1 FROM sla_alerts a WHERE a.lead_id = leads.id AND a.policy_id = $2 AND a.resolved_at IS NULL)
            LIMIT 500`,
          [p.no_activity_hours, p.id],
        );
        for (const lead of stale) {
          if (!evaluateCondition(p.condition_json, { lead })) continue;
          await tenantQuery(
            tenant,
            `INSERT INTO sla_alerts (policy_id, lead_id, assigned_to) VALUES ($1,$2,$3)`,
            [p.id, lead.id, lead.assigned_to],
          );
          if (lead.assigned_to) {
            await pushNotification(tenant, {
              user_id: lead.assigned_to,
              type: 'sla_alert',
              message: 'Lead inactive — SLA breached',
              metadata_json: { lead_id: lead.id, policy_id: p.id },
              link: `/leads/${lead.id}`,
            });
          }
        }

        // Escalate
        if (p.escalate_after_hours) {
          const { rows: toEscalate } = await tenantQuery(
            tenant,
            `SELECT a.id, a.lead_id, a.assigned_to, u.manager_id
               FROM sla_alerts a LEFT JOIN users u ON u.id = a.assigned_to
              WHERE a.policy_id = $1 AND a.resolved_at IS NULL AND a.escalated_at IS NULL
                AND a.flagged_at < now() - ($2 * interval '1 hour')
              LIMIT 200`,
            [p.id, p.escalate_after_hours],
          );
          for (const e of toEscalate) {
            await tenantQuery(tenant, `UPDATE sla_alerts SET escalated_at = now() WHERE id = $1`, [e.id]);
            if (e.manager_id) {
              await pushNotification(tenant, {
                user_id: e.manager_id,
                type: 'sla_escalation',
                message: 'A team member has an unresolved SLA alert',
                metadata_json: { alert_id: e.id, lead_id: e.lead_id },
                link: `/leads/${e.lead_id}`,
              });
            }
          }
        }

        // Auto-resolve on activity
        await tenantQuery(
          tenant,
          `UPDATE sla_alerts a
              SET resolved_at = now(), resolution_reason = 'activity_logged'
             FROM leads l
            WHERE a.lead_id = l.id AND a.policy_id = $1 AND a.resolved_at IS NULL
              AND l.last_activity_at > a.flagged_at`,
          [p.id],
        );
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'sla-scanner failed');
  }
};
setInterval(tick, 10 * 60_000);
setTimeout(tick, 60_000);
