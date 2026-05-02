import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES, EVENT_TYPES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { pushNotification } from '../modules/notifications/service.js';
import { logger } from '../lib/logger.js';

// Listens on the generic events queue. Emits in-app notifications for key events.
registerWorker(QUEUE_NAMES.EVENTS, async ({ data }) => {
  try {
    const tenant = await resolveTenantById(data.tenantId);
    if (!tenant) return;

    if (data.type === EVENT_TYPES.LEAD_ASSIGNED && data.payload?.assigned_to) {
      await pushNotification(tenant, {
        user_id: data.payload.assigned_to,
        type: 'lead_assigned',
        message: 'A new lead has been assigned to you',
        metadata_json: { lead_id: data.entityId },
        link: `/leads/${data.entityId}`,
      });
    }

    if (data.type === EVENT_TYPES.FOLLOWUP_DUE && data.payload?.user_id) {
      await pushNotification(tenant, {
        user_id: data.payload.user_id,
        type: 'follow_up_due',
        message: 'A follow-up is due',
        metadata_json: { follow_up_id: data.entityId, lead_id: data.payload?.lead_id },
        link: `/leads/${data.payload?.lead_id}`,
      });
    }

    if (data.type === EVENT_TYPES.MESSAGE_REPLIED && data.payload?.routed_to_user_id) {
      await pushNotification(tenant, {
        user_id: data.payload.routed_to_user_id,
        type: 'message_received',
        message: 'Lead replied',
        metadata_json: { lead_id: data.payload?.lead_id, channel: data.payload?.channel },
      });
    }

    if (data.type === EVENT_TYPES.PAYMENT_SUCCEEDED && data.payload?.lead_id) {
      const { rows } = await tenantQuery(tenant, `SELECT assigned_to FROM leads WHERE id = $1`, [data.payload.lead_id]);
      if (rows[0]?.assigned_to) {
        await pushNotification(tenant, {
          user_id: rows[0].assigned_to,
          type: 'payment_received',
          message: 'Payment received from your lead',
          metadata_json: { lead_id: data.payload.lead_id, amount: data.payload?.amount },
        });
      }
    }
  } catch (err) {
    logger.error({ err: err.message }, 'notification-worker failed');
  }
}, { concurrency: 4, jobName: '*' });
