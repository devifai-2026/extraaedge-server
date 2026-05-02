import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { isValidRRule } from '../../lib/rrule.js';
import { forbidden, notFound, validationError } from '../../lib/errors.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const TYPES = z.enum(['leave', 'half_day', 'training', 'meeting', 'custom']);

const createSchema = z.object({
  starts_at: z.coerce.date(),
  ends_at: z.coerce.date(),
  type: TYPES,
  note: z.string().optional(),
  is_recurring: z.boolean().default(false),
  recurrence_rule: z.string().optional(),
}).refine((v) => v.ends_at > v.starts_at, { message: 'ends_at must be after starts_at', path: ['ends_at'] });
const updateSchema = createSchema.partial();
const userParam = z.object({ userId: z.string().uuid() });
const idParam = z.object({ id: z.string().uuid() });

router.get('/user/:userId', validate({ params: userParam }), async (req, res, next) => {
  try {
    if (req.user.id !== req.params.userId && ![SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER].includes(req.user.role)) {
      throw forbidden('Can only view your own availability');
    }
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM user_availability WHERE user_id = $1 AND deleted_at IS NULL ORDER BY starts_at DESC`,
      [req.params.userId],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/user/:userId', validate({ params: userParam, body: createSchema }), async (req, res, next) => {
  try {
    if (req.user.id !== req.params.userId && ![SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER].includes(req.user.role)) {
      throw forbidden('Cannot set availability for other users');
    }
    if (req.body.recurrence_rule && !isValidRRule(req.body.recurrence_rule)) {
      throw validationError([{ path: 'recurrence_rule', message: 'invalid RRULE' }]);
    }
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO user_availability (user_id, starts_at, ends_at, type, note, is_recurring, recurrence_rule)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [req.params.userId, req.body.starts_at, req.body.ends_at, req.body.type, req.body.note ?? null, req.body.is_recurring, req.body.recurrence_rule ?? null],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id', validate({ params: idParam, body: updateSchema }), async (req, res, next) => {
  try {
    const { rows: existing } = await tenantQuery(req.tenant, `SELECT user_id FROM user_availability WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!existing[0]) throw notFound('Availability entry not found');
    if (existing[0].user_id !== req.user.id && ![SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER].includes(req.user.role)) {
      throw forbidden('Not yours');
    }
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i}`); params.push(v); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE user_availability SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    await tenantQuery(req.tenant, `UPDATE user_availability SET deleted_at = now() WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// Who's currently unavailable? — used by assignment-rules worker.
router.get('/now', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT DISTINCT u.id, u.name, u.email, ua.type, ua.ends_at
         FROM user_availability ua
         JOIN users u ON u.id = ua.user_id
        WHERE ua.deleted_at IS NULL AND now() BETWEEN ua.starts_at AND ua.ends_at AND u.deleted_at IS NULL
        ORDER BY ua.ends_at`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/calendar', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT ua.*, u.name AS user_name
         FROM user_availability ua JOIN users u ON u.id = ua.user_id
        WHERE ua.deleted_at IS NULL AND ua.starts_at > now() - interval '30 days'
        ORDER BY ua.starts_at`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
