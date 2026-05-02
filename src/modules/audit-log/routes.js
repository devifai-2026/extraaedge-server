import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired, requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN));

const query = z.object({
  entity_type: z.string().optional(),
  entity_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  action: z.string().optional(),
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

router.get('/', validate({ query }), async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.entity_type) { params.push(req.query.entity_type); conds.push(`entity_type = $${params.length}`); }
    if (req.query.entity_id) { params.push(req.query.entity_id); conds.push(`entity_id = $${params.length}`); }
    if (req.query.user_id) { params.push(req.query.user_id); conds.push(`user_id = $${params.length}`); }
    if (req.query.action) { params.push(req.query.action); conds.push(`action = $${params.length}`); }
    if (req.query.date_from) { params.push(req.query.date_from); conds.push(`created_at >= $${params.length}`); }
    if (req.query.date_to) { params.push(req.query.date_to); conds.push(`created_at <= $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id, page: req.query.page, limit: req.query.limit } });
  } catch (err) { next(err); }
});

export default router;
