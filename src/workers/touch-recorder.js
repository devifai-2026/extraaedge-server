import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES, EVENT_TYPES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { logger } from '../lib/logger.js';

// Maps communication events into lead_touches rows, enabling last-touch attribution updates.
registerWorker(QUEUE_NAMES.EVENTS, async ({ data }) => {
  const interestingTypes = [
    EVENT_TYPES.MESSAGE_SENT,
    EVENT_TYPES.MESSAGE_DELIVERED,
    EVENT_TYPES.MESSAGE_REPLIED,
    EVENT_TYPES.CALL_COMPLETED,
  ];
  if (!interestingTypes.includes(data.type)) return;
  try {
    const tenant = await resolveTenantById(data.tenantId);
    if (!tenant) return;
    const lead_id = data.payload?.lead_id ?? data.entityId;
    if (!lead_id) return;
    await tenantQuery(
      tenant,
      `INSERT INTO lead_touches (lead_id, touch_type, channel, source, metadata_json, occurred_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
      [lead_id, data.type, data.payload?.channel ?? null, data.payload?.provider ?? null, JSON.stringify(data.payload ?? {})],
    );
  } catch (err) {
    logger.error({ err: err.message }, 'touch-recorder failed');
  }
}, { concurrency: 4, jobName: '*' });
