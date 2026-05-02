import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES, EVENT_TYPES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { logger } from '../lib/logger.js';

// Snapshot attribution on payment.succeeded — immutable record for ROI analytics.
registerWorker(QUEUE_NAMES.EVENTS, async ({ data }) => {
  if (data.type !== EVENT_TYPES.PAYMENT_SUCCEEDED) return;
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;
  try {
    const payment_id = data.entityId ?? data.payload?.provider_payment_id;
    if (!payment_id) return;
    const { rows: [pay] } = await tenantQuery(tenant, `SELECT id, lead_id, amount FROM payments WHERE provider_payment_id = $1 OR id = $1::uuid LIMIT 1`, [String(payment_id)]).catch(() => ({ rows: [] }));
    if (!pay) return;
    const { rows: [lead] } = await tenantQuery(tenant, `SELECT first_touch_campaign_id, first_touch_channel, first_touch_source, first_touch_at, last_touch_campaign_id, last_touch_channel, last_touch_source, last_touch_at FROM leads WHERE id = $1`, [pay.lead_id]);
    if (!lead) return;
    await tenantQuery(
      tenant,
      `INSERT INTO payment_attributions (payment_id, lead_id, first_touch_campaign_id, first_touch_channel, first_touch_source, first_touch_at, last_touch_campaign_id, last_touch_channel, last_touch_source, last_touch_at, amount_attributed_first, amount_attributed_last, attribution_model)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'50_50')
       ON CONFLICT (payment_id) DO NOTHING`,
      [pay.id, pay.lead_id, lead.first_touch_campaign_id, lead.first_touch_channel, lead.first_touch_source, lead.first_touch_at, lead.last_touch_campaign_id, lead.last_touch_channel, lead.last_touch_source, lead.last_touch_at, pay.amount / 2, pay.amount / 2],
    );
  } catch (err) {
    logger.error({ err: err.message }, 'attribution-snapshotter failed');
  }
}, { concurrency: 4, jobName: '*' });
