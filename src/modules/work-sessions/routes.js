import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { teamHierarchy } from '../users/repo.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const listQuery = z.object({
  user_id: z.string().uuid().optional(),
  date_from: z.coerce.date().optional(),
  date_to: z.coerce.date().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

router.get('/me', async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT * FROM work_sessions WHERE user_id = $1 ORDER BY started_at DESC LIMIT 90`,
      [req.user.id],
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/me/today', async (req, res, next) => {
  try {
    const { rows: bucketsRows } = await tenantQuery(
      req.tenant,
      `SELECT count(*)::int AS active_minutes FROM work_activity_minutes WHERE user_id = $1 AND minute_bucket >= date_trunc('day', now())`,
      [req.user.id],
    );
    res.json({ data: { active_minutes_today: bucketsRows[0].active_minutes }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ query: listQuery }), async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    // Managers only see their team hierarchy
    if (req.user.role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
      const ids = await teamHierarchy(req.tenant, req.user.id);
      params.push(ids);
      conds.push(`user_id = ANY($${params.length}::uuid[])`);
    }
    if (req.query.user_id) { params.push(req.query.user_id); conds.push(`user_id = $${params.length}`); }
    if (req.query.date_from) { params.push(req.query.date_from); conds.push(`started_at >= $${params.length}`); }
    if (req.query.date_to) { params.push(req.query.date_to); conds.push(`started_at <= $${params.length}`); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT ws.*, u.name AS user_name FROM work_sessions ws JOIN users u ON u.id = ws.user_id
       ${where} ORDER BY ws.started_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/team-summary', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    let userIds = null;
    if (req.user.role === SYSTEM_TENANT_ROLES.SALES_MANAGER) {
      userIds = await teamHierarchy(req.tenant, req.user.id);
    }
    const params = userIds ? [userIds] : [];
    const filter = userIds ? 'WHERE u.id = ANY($1::uuid[])' : '';
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT u.id, u.name, u.role,
              COALESCE(sum(ws.active_minutes),0)::int AS active_minutes_7d,
              count(ws.id)::int AS session_count_7d,
              COALESCE(AVG(ws.active_minutes),0)::int AS avg_session_minutes
         FROM users u LEFT JOIN work_sessions ws ON ws.user_id = u.id AND ws.started_at > now() - interval '7 days'
        ${filter}
        GROUP BY u.id, u.name, u.role ORDER BY active_minutes_7d DESC`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
