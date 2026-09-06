import { sysQuery } from '../db/system.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { pushNotification } from '../modules/notifications/service.js';
import { evaluateCondition } from '../services/rule-engine.js';
import { managerChain } from '../modules/users/repo.js';
import { pickSameRoleReplacement, policyReassignsOnEscalation } from '../modules/sla/reassign.js';
import { publish } from '../lib/queue.js';
import { QUEUE_NAMES, EVENT_TYPES } from '../config/constants.js';
import { logger } from '../lib/logger.js';

// Notify the lead's owner AND everyone above them — their sales manager /
// telecaller lead, the branch manager, and the tenant's super_admins.
// managerChain() walks users.manager_id upward and appends every active
// super_admin, so one call covers the whole escalation audience.
//
// De-duplicated because the chain can legitimately contain someone twice (a
// super_admin who is also a manager_id in the chain), and nobody wants the
// same alert twice.
const notifyOwnerAndChain = async (tenant, { ownerId, type, message, metadata, link }) => {
  const recipients = new Set();
  if (ownerId) recipients.add(ownerId);
  if (ownerId) {
    try {
      for (const id of await managerChain(tenant, ownerId)) recipients.add(id);
    } catch (err) {
      // A broken chain must not swallow the owner's own notification.
      logger.warn({ tenantId: tenant.id, ownerId, err: err.message }, 'sla: manager chain lookup failed');
    }
  }
  for (const user_id of recipients) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await pushNotification(tenant, { user_id, type, message, metadata_json: metadata, link });
    } catch (err) {
      logger.warn({ tenantId: tenant.id, user_id, err: err.message }, 'sla: notification failed');
    }
  }
};

// Hand a stale lead to a fresh owner in the same role class and record it
// everywhere an assignment has to show up: the denormalized owner on `leads`,
// the append-only `lead_assignments` ledger, the `lead_activities` timeline,
// the events queue and the websocket.
//
// NOTHING IS DELETED — the previous assignment row is closed by setting
// is_active = false (the `one_active_assignment_per_lead` partial unique index
// allows exactly one active row), and a new row is appended alongside it, so
// the full ownership history survives.
const reassignStaleLead = async (tenant, { leadId, fromUserId, toUserId, policyId, alertId }) => {
  // Snap manager_id + branch_id to the new owner, same as every other
  // assignment path (rule-processor.commitAssignment, lead-assignments).
  const { rows: [target] } = await tenantQuery(
    tenant,
    `SELECT manager_id, branch_id FROM users WHERE id = $1`,
    [toUserId],
  );
  const { rows: [lead] } = await tenantQuery(
    tenant,
    `UPDATE leads
        SET assigned_to = $2, manager_id = $3, branch_id = $4, last_activity_at = now()
      WHERE id = $1
      RETURNING id, name`,
    [leadId, toUserId, target?.manager_id ?? null, target?.branch_id ?? null],
  );
  if (!lead) return;

  // Close the outgoing assignment, then append the new one.
  await tenantQuery(
    tenant,
    `UPDATE lead_assignments SET is_active = false, status = 'closed'
      WHERE lead_id = $1 AND is_active = true`,
    [leadId],
  );
  await tenantQuery(
    tenant,
    `INSERT INTO lead_assignments
       (lead_id, from_user_id, assigned_to, assigned_by, assignment_type, reason, is_active, status)
     VALUES ($1,$2,$3,NULL,'auto_assign',$4,true,'open')`,
    [leadId, fromUserId, toUserId, 'SLA: no activity — auto-reassigned'],
  );
  await tenantQuery(
    tenant,
    `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
     VALUES ($1, NULL, 'auto_assign', $2, $3::jsonb)`,
    [
      leadId,
      'Auto-reassigned — no activity within the SLA window',
      JSON.stringify({ assigned_to: toUserId, previous_owner_id: fromUserId, policy_id: policyId, sla_alert_id: alertId }),
    ],
  );

  await publish(QUEUE_NAMES.EVENTS, EVENT_TYPES.LEAD_ASSIGNED, {
    type: EVENT_TYPES.LEAD_ASSIGNED,
    tenantId: tenant.id,
    occurredAt: new Date().toISOString(),
    entityType: 'lead',
    entityId: leadId,
    payload: { assigned_to: toUserId, previous_owner_id: fromUserId, policy_id: policyId, sla_reassign: true },
  });
  const { notifyLeadChange } = await import('../lib/socket.js');
  notifyLeadChange({
    tenant,
    lead: { id: leadId, name: lead.name, assigned_to: toUserId },
    previous_owner_id: fromUserId,
    type: 'lead.assigned',
    actor_id: null,
    payload: { policy_id: policyId, sla_reassign: true, auto: true },
  }).catch(() => {});

  // Tell the incoming owner they have a new lead, and the outgoing owner why
  // they lost it — plus the managers above the OLD owner, who were the ones
  // warned on day 6.
  await pushNotification(tenant, {
    user_id: toUserId,
    type: 'sla_reassigned_to_you',
    message: 'A lead was reassigned to you after its owner went inactive',
    metadata_json: { lead_id: leadId, previous_owner_id: fromUserId, policy_id: policyId },
    link: `/leads/${leadId}`,
  }).catch(() => {});
  await notifyOwnerAndChain(tenant, {
    ownerId: fromUserId,
    type: 'sla_reassigned_away',
    message: 'A lead was auto-reassigned after no activity within the SLA window',
    metadata: { lead_id: leadId, new_owner_id: toUserId, policy_id: policyId },
    link: `/leads/${leadId}`,
  });
};

const tick = async () => {
  try {
    const { rows: tenants } = await sysQuery(`SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL`);
    for (const { id } of tenants) {
      const tenant = await resolveTenantById(id);
      if (!tenant) continue;
      const { rows: policies } = await tenantQuery(tenant, `SELECT * FROM sla_policies WHERE is_active AND deleted_at IS NULL`);
      for (const p of policies) {
        // ---- Flag stale leads (day 6) ----------------------------------
        // Only leads that are OWNED and still open can go stale: an
        // unassigned lead has no one to chase it, and a converted or dead
        // lead is finished. Both guards live in SQL so they're indexable and
        // can't be forgotten in a policy's condition_json.
        //
        // The SELECT carries the attribution + lifecycle columns so
        // evaluateCondition can actually test them; it used to fetch only
        // (id, assigned_to), which made almost every condition_json field
        // undefined.
        //
        // BACKLOG GUARD (`last_activity_at >= $3`): a policy only judges
        // inactivity that happened ON ITS WATCH. leads.last_activity_at is
        // NOT NULL DEFAULT now(), so without this the very first tick after a
        // policy is created would flag — and, for a reassigning policy,
        // redistribute — every lead in the tenant that had been quiet for
        // longer than the window, which on an established tenant is most of
        // the database. That is the mass-reassignment failure the assignment
        // engine's own comments call "the SpeedUp incident". A lead last
        // touched before the policy existed is left with its owner; touch it
        // once and it enters the rotation normally. To sweep a pre-existing
        // backlog deliberately, do it through the Lead Manager's bulk
        // reassign, where a human picks the targets.
        const { rows: stale } = await tenantQuery(
          tenant,
          `SELECT id, name, assigned_to, stage_id, sub_stage_id, program_id, branch_id,
                  lead_score, is_cold, converted_at, created_at, last_activity_at,
                  first_touch_channel, first_touch_source
             FROM leads
            WHERE deleted_at IS NULL
              AND assigned_to IS NOT NULL
              AND converted_at IS NULL
              AND last_activity_at < now() - ($1 * interval '1 hour')
              AND last_activity_at >= $3
              AND NOT EXISTS (SELECT 1 FROM sla_alerts a WHERE a.lead_id = leads.id AND a.policy_id = $2 AND a.resolved_at IS NULL)
            ORDER BY last_activity_at
            LIMIT 500`,
          [p.no_activity_hours, p.id, p.created_at],
        );
        for (const lead of stale) {
          if (!evaluateCondition(p.condition_json, { lead })) continue;
          // eslint-disable-next-line no-await-in-loop
          const { rows: [alert] } = await tenantQuery(
            tenant,
            `INSERT INTO sla_alerts (policy_id, lead_id, assigned_to) VALUES ($1,$2,$3) RETURNING id`,
            [p.id, lead.id, lead.assigned_to],
          );
          // Day 6: the owner AND their sales manager / branch manager / admin.
          // eslint-disable-next-line no-await-in-loop
          await notifyOwnerAndChain(tenant, {
            ownerId: lead.assigned_to,
            type: 'sla_alert',
            message: `No activity on "${lead.name || 'a lead'}" — it will be reassigned if untouched`,
            metadata: { lead_id: lead.id, policy_id: p.id, alert_id: alert?.id },
            link: `/leads/${lead.id}`,
          });
        }

        // ---- Escalate (day 7) ------------------------------------------
        if (p.escalate_after_hours) {
          const reassigns = policyReassignsOnEscalation(p);
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
            // eslint-disable-next-line no-await-in-loop
            await tenantQuery(tenant, `UPDATE sla_alerts SET escalated_at = now() WHERE id = $1`, [e.id]);

            // Hand the lead to a fresh owner in the same role class. Skipped
            // when the policy doesn't ask for it, or when there is nobody
            // else in that class — in which case the notification below is
            // still the escalation.
            let reassignedTo = null;
            if (reassigns && e.assigned_to) {
              // eslint-disable-next-line no-await-in-loop
              reassignedTo = await pickSameRoleReplacement(tenant, e.assigned_to);
              if (reassignedTo) {
                // eslint-disable-next-line no-await-in-loop
                await reassignStaleLead(tenant, {
                  leadId: e.lead_id,
                  fromUserId: e.assigned_to,
                  toUserId: reassignedTo,
                  policyId: p.id,
                  alertId: e.id,
                });
                // The lead now has an engaged owner; the breach is handled.
                // eslint-disable-next-line no-await-in-loop
                await tenantQuery(
                  tenant,
                  `UPDATE sla_alerts SET resolved_at = now(), resolution_reason = 'auto_reassigned' WHERE id = $1`,
                  [e.id],
                );
              } else {
                logger.warn(
                  { tenantId: tenant.id, leadId: e.lead_id, ownerId: e.assigned_to },
                  'sla: no same-role replacement available — lead kept with current owner',
                );
              }
            }

            // reassignStaleLead already notified the old owner + their chain,
            // so only notify here when nothing was reassigned.
            if (!reassignedTo && e.manager_id) {
              // eslint-disable-next-line no-await-in-loop
              await pushNotification(tenant, {
                user_id: e.manager_id,
                type: 'sla_escalation',
                message: 'A team member has an unresolved SLA alert',
                metadata_json: { alert_id: e.id, lead_id: e.lead_id },
                link: `/leads/${e.lead_id}`,
              }).catch(() => {});
            }
          }
        }

        // ---- Auto-resolve on activity ----------------------------------
        // The owner touched the lead before the window closed, so the breach
        // is over and no reassignment happens.
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

// Exported so a test or an ops script can force one pass without waiting for
// the interval.
export { tick as runSlaScan };
