import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { forbidden, notFound } from '../../lib/errors.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const createSchema = z.object({
  channel: z.enum(['email', 'sms', 'whatsapp']),
  template_id: z.string().uuid(),
  lead_ids: z.array(z.string().uuid()).min(1).max(5000),
  scheduled_for: z.coerce.date(),
  variable_overrides: z.record(z.string(), z.any()).optional(),
  respects_business_hours: z.boolean().default(true),
});
const idParam = z.object({ id: z.string().uuid() });

router.post('/', validate({ body: createSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO scheduled_sends (user_id, channel, template_id, lead_ids, scheduled_for, variable_overrides_json, respects_business_hours, status)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'scheduled') RETURNING *`,
      [req.user.id, req.body.channel, req.body.template_id, req.body.lead_ids, req.body.scheduled_for, req.body.variable_overrides ? JSON.stringify(req.body.variable_overrides) : null, req.body.respects_business_hours],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM scheduled_sends WHERE deleted_at IS NULL AND (user_id = $1 OR $2) ORDER BY scheduled_for DESC LIMIT 200`,
      [req.user.id, req.user.role === 'super_admin'],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM scheduled_sends WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!rows[0]) throw notFound('Scheduled send not found');
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows: existing } = await tenantQuery(req.tenant, `SELECT user_id, status FROM scheduled_sends WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!existing[0]) throw notFound('Scheduled send not found');
    if (existing[0].user_id !== req.user.id && req.user.role !== 'super_admin' && req.user.role !== 'sales_manager') throw forbidden('Not yours');
    if (existing[0].status !== 'scheduled') throw forbidden('Only scheduled sends can be cancelled');
    await tenantQuery(req.tenant, `UPDATE scheduled_sends SET status = 'cancelled', deleted_at = now() WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
