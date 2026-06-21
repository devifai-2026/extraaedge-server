import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const dripSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  category: z.string().optional(),
  start_time: z.coerce.date().optional(),
  active: z.boolean().default(false),
});
const ruleSchema = z.object({
  step_order: z.coerce.number().int().min(1),
  day_offset: z.coerce.number().int().min(0),
  channel: z.enum(['email', 'sms', 'whatsapp']),
  template_id: z.string().uuid(),
  condition_json: z.record(z.string(), z.any()).optional(),
});
const idParam = z.object({ id: z.string().uuid() });
const ruleIdParams = z.object({ id: z.string().uuid(), rid: z.string().uuid() });

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM campaigns_drip WHERE deleted_at IS NULL ORDER BY created_at DESC`);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const [{ rows: drips }, { rows: rules }] = await Promise.all([
      tenantQuery(req.tenant, `SELECT * FROM campaigns_drip WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]),
      tenantQuery(req.tenant, `SELECT * FROM campaigns_drip_rules WHERE drip_id = $1 ORDER BY step_order`, [req.params.id]),
    ]);
    if (!drips[0]) throw notFound('Drip campaign not found');
    res.json({ data: { ...drips[0], rules }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ body: dripSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO campaigns_drip (name, description, category, start_time, active, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.body.name, req.body.description ?? null, req.body.category ?? null, req.body.start_time ?? null, req.body.active, req.user.id],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: dripSchema.partial() }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i}`); params.push(v); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE campaigns_drip SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE campaigns_drip SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

router.post('/:id/toggle', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `UPDATE campaigns_drip SET active = NOT active WHERE id = $1 AND deleted_at IS NULL RETURNING *`, [req.params.id]);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Rules (steps)
router.post('/:id/rules', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: ruleSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO campaigns_drip_rules (drip_id, step_order, day_offset, channel, template_id, condition_json)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb) RETURNING *`,
      [req.params.id, req.body.step_order, req.body.day_offset, req.body.channel, req.body.template_id, JSON.stringify(req.body.condition_json ?? {})],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id/rules/:rid', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: ruleIdParams, body: ruleSchema.partial() }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      const val = k === 'condition_json' ? JSON.stringify(v) : v;
      fields.push(`${k} = $${i}`); params.push(val); i += 1;
    }
    params.push(req.params.rid, req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE campaigns_drip_rules SET ${fields.join(', ')} WHERE id = $${i} AND drip_id = $${i + 1} RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id/rules/:rid', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: ruleIdParams }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `DELETE FROM campaigns_drip_rules WHERE id = $1 AND drip_id = $2`, [req.params.rid, req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

router.get('/:id/runs', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM campaigns_drip_runs WHERE drip_id = $1 ORDER BY executed_at DESC LIMIT 500`,
      [req.params.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/:id/stats', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT status, count(*)::int AS n FROM campaigns_drip_runs WHERE drip_id = $1 GROUP BY status`,
      [req.params.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
