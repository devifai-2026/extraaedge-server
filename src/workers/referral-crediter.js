import { registerWorker } from '../lib/queue.js';
import { QUEUE_NAMES, EVENT_TYPES } from '../config/constants.js';
import { resolveTenantById, tenantQuery } from '../db/tenant.js';
import { logger } from '../lib/logger.js';

registerWorker(QUEUE_NAMES.EVENTS, async ({ data }) => {
  if (![EVENT_TYPES.LEAD_CREATED, EVENT_TYPES.PAYMENT_SUCCEEDED].includes(data.type)) return;
  const tenant = await resolveTenantById(data.tenantId);
  if (!tenant) return;
  try {
    const lead_id = data.payload?.lead?.id ?? data.payload?.lead_id;
    if (!lead_id) return;
    const { rows: [lead] } = await tenantQuery(tenant, `SELECT id, referred_by_lead_id FROM leads WHERE id = $1`, [lead_id]);
    if (!lead?.referred_by_lead_id) return;
    const trigger = data.type === EVENT_TYPES.LEAD_CREATED ? 'lead_created' : 'payment_succeeded';
    const { rows: policies } = await tenantQuery(tenant, `SELECT * FROM referral_policies WHERE is_active AND deleted_at IS NULL AND trigger = $1`, [trigger]);
    for (const p of policies) {
      await tenantQuery(
        tenant,
        `INSERT INTO referral_credits (referrer_lead_id, referred_lead_id, policy_id, trigger_event, credit_type, credit_amount, status)
         VALUES ($1,$2,$3,$4,$5,$6,'pending')`,
        [lead.referred_by_lead_id, lead.id, p.id, trigger, p.credit_type, p.credit_amount],
      );
    }
  } catch (err) {
    logger.error({ err: err.message }, 'referral-crediter failed');
  }
}, { concurrency: 2, jobName: '*' });
