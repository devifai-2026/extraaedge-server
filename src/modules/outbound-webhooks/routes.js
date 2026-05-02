import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { randomToken } from '../../lib/crypto.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const createSchema = z.object({
  name: z.string().min(1),
  target_url: z.string().url(),
  event_types: z.array(z.string()).min(1),
  is_active: z.boolean().default(true),
  custom_headers_json: z.record(z.string(), z.string()).optional(),
  retry_config_json: z.object({ max: z.number().int(), backoff_ms: z.array(z.number().int()) }).optional(),
});
const updateSchema = createSchema.partial();
const idParam = z.object({ id: z.string().uuid() });

router.get('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT id, name, target_url, event_types, is_active, created_at, updated_at FROM outbound_webhooks WHERE deleted_at IS NULL ORDER BY name`);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: createSchema }), async (req, res, next) => {
  try {
    const secret = randomToken(24);
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO outbound_webhooks (name, target_url, secret, event_types, is_active, custom_headers_json, retry_config_json, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,COALESCE($7::jsonb, retry_config_json),$8)
       RETURNING id, name, target_url, secret, event_types, is_active, custom_headers_json, retry_config_json, created_at`,
      [req.body.name, req.body.target_url, secret, req.body.event_types, req.body.is_active, req.body.custom_headers_json ? JSON.stringify(req.body.custom_headers_json) : null, req.body.retry_config_json ? JSON.stringify(req.body.retry_config_json) : null, req.user.id],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam, body: updateSchema }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      const val = ['custom_headers_json', 'retry_config_json'].includes(k) ? JSON.stringify(v) : v;
      fields.push(`${k} = $${i}`); params.push(val); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE outbound_webhooks SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING id, name, target_url, event_types, is_active`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE outbound_webhooks SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

router.post('/:id/test', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows: [wh] } = await tenantQuery(req.tenant, `SELECT * FROM outbound_webhooks WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!wh) throw notFound('Webhook not found');
    await tenantQuery(
      req.tenant,
      `INSERT INTO outbound_webhook_deliveries (webhook_id, event_type, payload_json, scheduled_for, status)
       VALUES ($1, 'test.ping', $2::jsonb, now(), 'pending')`,
      [wh.id, JSON.stringify({ test: true, at: new Date().toISOString() })],
    );
    res.status(202).json({ data: { queued: true }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id/deliveries', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM outbound_webhook_deliveries WHERE webhook_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.params.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/deliveries/:id/retry', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam }), async (req, res, next) => {
  try {
    await tenantQuery(
      req.tenant,
      `UPDATE outbound_webhook_deliveries SET status = 'pending', scheduled_for = now(), next_retry_at = NULL WHERE id = $1 AND status IN ('failed','dead')`,
      [req.params.id],
    );
    res.status(202).end();
  } catch (err) { next(err); }
});

export default router;
