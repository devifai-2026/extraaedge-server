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

const ENTITY = z.enum(['lead', 'user', 'program']);
const FIELD_TYPE = z.enum(['text', 'number', 'select', 'multiselect', 'date', 'boolean', 'url', 'email', 'textarea']);

const createSchema = z.object({
  entity: ENTITY,
  key: z.string().regex(/^[a-z][a-z0-9_]*$/u, 'snake_case required'),
  label: z.string().min(1),
  field_type: FIELD_TYPE,
  options_json: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
  validation_json: z.record(z.string(), z.any()).optional(),
  is_required: z.boolean().default(false),
  is_searchable: z.boolean().default(false),
  show_in_list: z.boolean().default(false),
  show_in_form_tab: z.string().optional(),
  order_index: z.number().int().default(0),
});

const updateSchema = createSchema.partial().omit({ entity: true, key: true });
const reorderSchema = z.object({ order: z.array(z.object({ id: z.string().uuid(), order_index: z.number().int() })) });
const idParam = z.object({ id: z.string().uuid() });
const listQuery = z.object({ entity: ENTITY.optional() });

router.get('/', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = ['deleted_at IS NULL'];
    const params = [];
    if (req.query.entity) { params.push(req.query.entity); conds.push(`entity = $${params.length}`); }
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM custom_field_definitions WHERE ${conds.join(' AND ')} ORDER BY entity, order_index, label`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: createSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO custom_field_definitions (entity, key, label, field_type, options_json, validation_json, is_required, is_searchable, show_in_list, show_in_form_tab, order_index)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.body.entity, req.body.key, req.body.label, req.body.field_type,
       req.body.options_json ? JSON.stringify(req.body.options_json) : null,
       req.body.validation_json ? JSON.stringify(req.body.validation_json) : null,
       req.body.is_required, req.body.is_searchable, req.body.show_in_list, req.body.show_in_form_tab ?? null, req.body.order_index],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam, body: updateSchema }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      const val = ['options_json', 'validation_json'].includes(k) ? JSON.stringify(v) : v;
      fields.push(`${k} = $${i}`); params.push(val); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE custom_field_definitions SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam }), async (req, res, next) => {
  try {
    await tenantQuery(req.tenant, `UPDATE custom_field_definitions SET deleted_at = now() WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

router.post('/reorder', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: reorderSchema }), async (req, res, next) => {
  try {
    for (const o of req.body.order) {
      await tenantQuery(req.tenant, `UPDATE custom_field_definitions SET order_index = $2 WHERE id = $1`, [o.id, o.order_index]);
    }
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
