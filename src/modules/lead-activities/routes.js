import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const listQuery = z.object({
  lead_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  type: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

router.get('/', validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.lead_id) { params.push(req.query.lead_id); conds.push(`lead_id = $${params.length}`); }
    if (req.query.user_id) { params.push(req.query.user_id); conds.push(`user_id = $${params.length}`); }
    if (req.query.type) { params.push(req.query.type); conds.push(`type = $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM lead_activities ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit } });
  } catch (err) { next(err); }
});

export default router;
