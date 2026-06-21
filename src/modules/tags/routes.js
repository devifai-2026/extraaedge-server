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

const createSchema = z.object({ name: z.string().min(1), color: z.string().optional() });
const updateSchema = createSchema.partial();
const idParam = z.object({ id: z.string().uuid() });

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM tags WHERE deleted_at IS NULL ORDER BY name`);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ body: createSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO tags (name, color, created_by) VALUES ($1,$2,$3) RETURNING *`,
      [req.body.name, req.body.color ?? null, req.user.id],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: updateSchema }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i}`); params.push(v); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE tags SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    await tenantQuery(req.tenant, `UPDATE tags SET deleted_at = now() WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

// Lead ↔ tag operations under /tags/lead/:leadId
router.post('/lead/:leadId', validate({ params: z.object({ leadId: z.string().uuid() }), body: z.object({ tag_ids: z.array(z.string().uuid()).min(1) }) }), async (req, res, next) => {
  try {
    for (const t of req.body.tag_ids) {
      await tenantQuery(
        req.tenant,
        `INSERT INTO lead_tags (lead_id, tag_id, assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [req.params.leadId, t, req.user.id],
      );
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

router.delete('/lead/:leadId/:tagId', validate({ params: z.object({ leadId: z.string().uuid(), tagId: z.string().uuid() }) }), async (req, res, next) => {
  try {
    await tenantQuery(req.tenant, `DELETE FROM lead_tags WHERE lead_id = $1 AND tag_id = $2`, [req.params.leadId, req.params.tagId]);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
