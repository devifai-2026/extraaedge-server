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
  name: z.string().min(1),
  filter_json: z.record(z.string(), z.any()),
  is_shared: z.boolean().default(false),
});
const updateSchema = createSchema.partial();
const idParam = z.object({ id: z.string().uuid() });

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM saved_filters WHERE (user_id = $1 OR is_shared = true) AND deleted_at IS NULL ORDER BY name`,
      [req.user.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', validate({ body: createSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO saved_filters (user_id, name, filter_json, is_shared) VALUES ($1,$2,$3::jsonb,$4) RETURNING *`,
      [req.user.id, req.body.name, JSON.stringify(req.body.filter_json), req.body.is_shared],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id', validate({ params: idParam, body: updateSchema }), async (req, res, next) => {
  try {
    const { rows: existing } = await tenantQuery(req.tenant, `SELECT user_id FROM saved_filters WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!existing[0]) throw notFound('Saved filter not found');
    if (existing[0].user_id !== req.user.id) throw forbidden('Not your filter');
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      const val = k === 'filter_json' ? JSON.stringify(v) : v;
      fields.push(`${k} = $${i}`); params.push(val); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE saved_filters SET ${fields.join(', ')} WHERE id = $${i} RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows: existing } = await tenantQuery(req.tenant, `SELECT user_id FROM saved_filters WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!existing[0]) throw notFound('Saved filter not found');
    if (existing[0].user_id !== req.user.id) throw forbidden('Not your filter');
    await tenantQuery(req.tenant, `UPDATE saved_filters SET deleted_at = now() WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
