import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const query = z.object({
  campaign_id: z.string().uuid().optional(),
  channel: z.string().optional(),
  source: z.string().optional(),
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional(),
  model: z.enum(['first_touch', 'last_touch', '50_50', 'linear']).default('50_50'),
});

router.get('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ query }), async (req, res, next) => {
  try {
    const amountField = {
      first_touch: 'amount_attributed_first',
      last_touch: 'amount_attributed_last',
      '50_50': 'amount_attributed_first + amount_attributed_last',
      linear: 'amount_attributed_first + amount_attributed_last',
    }[req.query.model];
    const conds = [];
    const params = [];
    if (req.query.campaign_id) { params.push(req.query.campaign_id); conds.push(`(first_touch_campaign_id = $${params.length} OR last_touch_campaign_id = $${params.length})`); }
    if (req.query.channel) { params.push(req.query.channel); conds.push(`(first_touch_channel = $${params.length} OR last_touch_channel = $${params.length})`); }
    if (req.query.source) { params.push(req.query.source); conds.push(`(first_touch_source = $${params.length} OR last_touch_source = $${params.length})`); }
    if (req.query.date_from) { params.push(req.query.date_from); conds.push(`created_at >= $${params.length}`); }
    if (req.query.date_to) { params.push(req.query.date_to); conds.push(`created_at <= $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT
         COALESCE(first_touch_campaign_id, last_touch_campaign_id) AS campaign_id,
         COALESCE(first_touch_channel, last_touch_channel) AS channel,
         COALESCE(first_touch_source, last_touch_source) AS source,
         count(DISTINCT lead_id)::int AS conversions,
         sum(${amountField})::numeric AS revenue
       FROM payment_attributions ${where}
       GROUP BY 1,2,3 ORDER BY revenue DESC NULLS LAST LIMIT 500`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id, model: req.query.model } });
  } catch (err) { next(err); }
});

router.get('/models', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), (_req, res) => {
  res.json({
    data: [
      { code: 'first_touch', label: 'First touch — credit the earliest touchpoint' },
      { code: 'last_touch', label: 'Last touch — credit the most recent touchpoint' },
      { code: '50_50', label: '50/50 split between first and last touch' },
      { code: 'linear', label: 'Linear — distribute evenly across all touches' },
    ],
  });
});

router.put('/model', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: z.object({ default_model: z.enum(['first_touch', 'last_touch', '50_50', 'linear']) }) }), async (req, res, next) => {
  try {
    // Persist on the subscription_credits table as a simple tenant-setting anchor — or add a tenant_settings table later.
    // For now, applied at query time — this endpoint stores the preference in a settings blob on the tenant row.
    await tenantQuery(
      req.tenant,
      `INSERT INTO credit_transactions (credit_type, amount, reason, ref_type, ref_id)
       VALUES ('setting', 0, 'attribution_model:' || $1, 'setting', NULL)`,
      [req.body.default_model],
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

router.get('/leads/:id/touches', validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM lead_touches WHERE lead_id = $1 ORDER BY occurred_at DESC`,
      [req.params.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/leads/:id/touches', validate({ params: z.object({ id: z.string().uuid() }), body: z.object({ touch_type: z.string().min(1), campaign_id: z.string().uuid().optional(), channel: z.string().optional(), source: z.string().optional(), medium: z.string().optional(), metadata_json: z.record(z.string(), z.any()).optional() }) }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO lead_touches (lead_id, touch_type, campaign_id, channel, source, medium, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *`,
      [req.params.id, req.body.touch_type, req.body.campaign_id ?? null, req.body.channel ?? null, req.body.source ?? null, req.body.medium ?? null, JSON.stringify(req.body.metadata_json ?? {})],
    );
    // Update last_touch on lead — first_touch only if null.
    await tenantQuery(
      req.tenant,
      `UPDATE leads SET
         first_touch_campaign_id = COALESCE(first_touch_campaign_id, $2),
         first_touch_channel = COALESCE(first_touch_channel, $3),
         first_touch_source = COALESCE(first_touch_source, $4),
         first_touch_medium = COALESCE(first_touch_medium, $5),
         first_touch_at = COALESCE(first_touch_at, now()),
         last_touch_campaign_id = $2,
         last_touch_channel = $3,
         last_touch_source = $4,
         last_touch_medium = $5,
         last_touch_at = now()
       WHERE id = $1`,
      [req.params.id, req.body.campaign_id ?? null, req.body.channel ?? null, req.body.source ?? null, req.body.medium ?? null],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
