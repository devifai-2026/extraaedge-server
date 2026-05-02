import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { publish } from '../../lib/queue.js';
import { SYSTEM_TENANT_ROLES, QUEUE_NAMES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired, requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER));

const listQuery = z.object({
  import_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
const idParam = z.object({ id: z.string().uuid() });

router.get('/', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.import_id) { params.push(req.query.import_id); conds.push(`import_id = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT f.*, i.created_at AS import_created_at
         FROM bulk_import_failures f
         JOIN bulk_imports i ON i.id = f.import_id
         ${where}
         ORDER BY f.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit } });
  } catch (err) { next(err); }
});

router.post('/:id/retry', validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM bulk_import_failures WHERE id = $1 AND retried_at IS NULL`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Failure row not found or already retried' } });
    await publish(QUEUE_NAMES.BULK_IMPORT, 'retry_row', { tenantId: req.tenant.id, failure_id: req.params.id });
    await tenantQuery(req.tenant, `UPDATE bulk_import_failures SET retried_at = now() WHERE id = $1`, [req.params.id]);
    res.status(202).end();
  } catch (err) { next(err); }
});

const editSchema = z.object({ raw_row_json: z.record(z.string(), z.any()) });
router.put('/:id', validate({ params: idParam, body: editSchema }), async (req, res, next) => {
  try {
    await tenantQuery(
      req.tenant,
      `UPDATE bulk_import_failures SET raw_row_json = $2::jsonb WHERE id = $1`,
      [req.params.id, JSON.stringify(req.body.raw_row_json)],
    );
    res.status(204).end();
  } catch (err) { next(err); }
});

router.delete('/:id', validate({ params: idParam }), async (req, res, next) => {
  try {
    await tenantQuery(req.tenant, `DELETE FROM bulk_import_failures WHERE id = $1`, [req.params.id]);
    res.status(204).end();
  } catch (err) { next(err); }
});

export default router;
