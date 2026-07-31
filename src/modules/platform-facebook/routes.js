// Cross-tenant Facebook / inbound-webhook console for the product_owner:
// view any tenant's raw inbound webhook payloads (Facebook Lead Ads bridge,
// LeadsBridge, generic inbound) captured in webhook_events. Read-only.
// PRODUCT_OWNER only — exposes tenant PII.
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import { resolveTenantById, tenantQuery } from '../../db/tenant.js';
import { tenantNotFound } from '../../lib/errors.js';

const router = express.Router();
router.use(authRequired, requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER));

const tenantParam = z.object({ tenantId: z.string().uuid() });
const requireTenant = async (id) => {
  const t = await resolveTenantById(id);
  if (!t) throw tenantNotFound();
  return t;
};
const notExist = (err) => { if (err?.code === '42P01') return { rows: [] }; throw err; };

// Raw inbound webhook events (Facebook Lead Ads + other inbound), newest first.
router.get('/:tenantId/webhook-events', validate({
  params: tenantParam,
  query: z.object({ since: z.string().optional(), status: z.enum(['pending', 'processed', 'failed']).optional(), limit: z.coerce.number().int().min(1).max(500).optional() }),
}), async (req, res, next) => {
  try {
    const t = await requireTenant(req.params.tenantId);
    const conds = []; const params = [];
    if (req.query.since) { params.push(req.query.since); conds.push(`we.received_at >= $${params.length}::timestamptz`); }
    if (req.query.status) { params.push(req.query.status); conds.push(`we.status = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    params.push(Math.min(Number(req.query.limit) || 100, 500));
    const { rows } = await tenantQuery(
      t,
      `SELECT we.id, we.event_type, we.status, we.error, we.payload_json, we.received_at,
              i.name AS integration_name, i.type AS integration_type
         FROM webhook_events we
         LEFT JOIN integrations i ON i.id = we.integration_id
         ${where}
        ORDER BY we.received_at DESC
        LIMIT $${params.length}`,
      params,
    ).catch(notExist);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Daily event counts for the last 30 days (graph), gap-filled.
router.get('/:tenantId/webhook-event-stats', validate({ params: tenantParam }), async (req, res, next) => {
  try {
    const t = await requireTenant(req.params.tenantId);
    const { rows } = await tenantQuery(
      t,
      `SELECT to_char(g.b, 'Mon DD') AS label,
              COALESCE(c.n, 0)::int AS events,
              COALESCE(c.failed, 0)::int AS failed
         FROM generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') g(b)
         LEFT JOIN (
           SELECT date_trunc('day', received_at) b, count(*) n,
                  count(*) FILTER (WHERE status = 'failed') failed
             FROM webhook_events
            WHERE received_at >= now() - interval '30 days'
            GROUP BY 1
         ) c ON c.b = g.b
        ORDER BY g.b`,
    ).catch(notExist);
    res.json({ data: { daily: rows }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
