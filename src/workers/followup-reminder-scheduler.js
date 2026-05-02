// Two scheduled passes per tick:
//   (1) Due-soon reminder — follow-ups within the next 15 minutes get a
//       gentle ping to the counsellor + creator. Tracked by reminder_sent_at.
//   (2) Overdue notice — follow-ups whose next_action_datetime has already
//       passed but status is still 'planned' fan out to the counsellor's
//       managers + every super_admin in the tenant. Tracked by
//       overdue_notified_at to avoid re-spamming each minute.
import { sysQuery } from '../db/system.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { pushNotification } from '../modules/notifications/service.js';
import { notifyUser, notifyAdmins } from '../lib/socket.js';
import { logger } from '../lib/logger.js';

// Resolve everyone who should hear about an overdue follow-up:
//   - the counsellor's primary manager (users.manager_id)
//   - every secondary manager (user_managers.manager_id)
//   - every active super_admin in the tenant
// Plus the counsellor themselves for their own dashboard.
const escalationTargets = async (tenant, counsellorId) => {
  const ids = new Set();
  if (counsellorId) ids.add(counsellorId);
  if (counsellorId) {
    const { rows } = await tenantQuery(
      tenant,
      `SELECT manager_id AS id FROM user_managers WHERE user_id = $1
       UNION
       SELECT manager_id AS id FROM users WHERE id = $1 AND manager_id IS NOT NULL`,
      [counsellorId],
    );
    for (const r of rows) if (r.id) ids.add(r.id);
  }
  const { rows: admins } = await tenantQuery(
    tenant,
    `SELECT id FROM users WHERE role = 'super_admin' AND deleted_at IS NULL AND is_active = true`,
  );
  for (const a of admins) ids.add(a.id);
  return Array.from(ids);
};

const fmtTime = (iso) => {
  try { return new Date(iso).toLocaleString('en-IN', { hour12: true }); }
  catch { return String(iso); }
};

const tick = async () => {
  try {
    const { rows: tenants } = await sysQuery(`SELECT id FROM tenants WHERE status = 'active' AND deleted_at IS NULL`);
    for (const { id } of tenants) {
      const tenant = await resolveTenantById(id);
      if (!tenant) continue;

      // (1) Due in next 15 minutes — counsellor + creator only.
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
            link: `/leadlist?focus=${f.lead_id}`,
          });
        }
        await tenantQuery(tenant, `UPDATE lead_followups SET reminder_sent_at = now() WHERE id = $1`, [f.id]);
      }

      // (2) Overdue — fan out to manager chain + super_admins.
      const { rows: overdue } = await tenantQuery(
        tenant,
        `SELECT f.id, f.lead_id, f.next_action_datetime,
                l.assigned_to, l.name AS lead_name,
                u.name AS counsellor_name
           FROM lead_followups f
           LEFT JOIN leads l ON l.id = f.lead_id
           LEFT JOIN users u ON u.id = l.assigned_to
          WHERE f.deleted_at IS NULL
            AND f.status = 'planned'
            AND f.overdue_notified_at IS NULL
            AND f.next_action_datetime < now()
          LIMIT 500`,
      );
      for (const f of overdue) {
        const counsellorLabel = f.counsellor_name ? `${f.counsellor_name}` : 'a counsellor';
        const message = `Follow-up missed by ${counsellorLabel} — ${f.lead_name ?? 'a lead'} (was due ${fmtTime(f.next_action_datetime)})`;
        const recipients = await escalationTargets(tenant, f.assigned_to);
        for (const uid of recipients) {
          await pushNotification(tenant, {
            user_id: uid,
            type: 'follow_up_overdue',
            message,
            metadata_json: {
              follow_up_id: f.id,
              lead_id: f.lead_id,
              counsellor_id: f.assigned_to,
              counsellor_name: f.counsellor_name,
              at: f.next_action_datetime,
            },
            link: `/leadlist?focus=${f.lead_id}`,
          });
          // Real-time socket push so the bell badge wakes up immediately.
          notifyUser(tenant.id, uid, 'follow_up.overdue', {
            follow_up_id: f.id,
            lead_id: f.lead_id,
            lead_name: f.lead_name,
            counsellor_id: f.assigned_to,
            counsellor_name: f.counsellor_name,
            at: f.next_action_datetime,
          });
        }
        // Always nudge the admin room too in case a super_admin isn't in
        // recipients (shouldn't happen, but cheap insurance).
        notifyAdmins(tenant.id, 'follow_up.overdue', {
          follow_up_id: f.id, lead_id: f.lead_id, lead_name: f.lead_name,
          counsellor_id: f.assigned_to, counsellor_name: f.counsellor_name,
          at: f.next_action_datetime,
        });
        await tenantQuery(
          tenant,
          `UPDATE lead_followups SET overdue_notified_at = now() WHERE id = $1`,
          [f.id],
        );
        // Drop a timeline activity so the breach is auditable on the lead.
        if (f.lead_id) {
          await tenantQuery(
            tenant,
            `INSERT INTO lead_activities (lead_id, user_id, type, summary, metadata_json)
             VALUES ($1, NULL, 'followup_overdue', $2, $3::jsonb)`,
            [
              f.lead_id,
              `Follow-up missed by ${counsellorLabel}`,
              JSON.stringify({ follow_up_id: f.id, was_due: f.next_action_datetime, counsellor_id: f.assigned_to }),
            ],
          );
        }
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'followup-reminder tick failed');
  }
};
setInterval(tick, 60_000);
setTimeout(tick, 5_000);
