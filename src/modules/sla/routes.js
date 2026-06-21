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

const policySchema = z.object({
  name: z.string().min(1),
  condition_json: z.record(z.string(), z.any()).default({}),
  no_activity_hours: z.coerce.number().int().positive(),
  escalate_after_hours: z.coerce.number().int().positive().optional(),
  action_json: z.array(z.any()).default([]),
  is_active: z.boolean().default(true),
});
const idParam = z.object({ id: z.string().uuid() });
const alertsQuery = z.object({
  user_id: z.string().uuid().optional(),
  status: z.enum(['open', 'resolved']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

// Policies
router.get('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try { const { rows } = await tenantQuery(req.tenant, `SELECT * FROM sla_policies WHERE deleted_at IS NULL ORDER BY name`); res.json({ data: rows, meta: { requestId: req.id } }); }
  catch (err) { next(err); }
});

router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ body: policySchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO sla_policies (name, condition_json, no_activity_hours, escalate_after_hours, action_json, is_active)
       VALUES ($1,$2::jsonb,$3,$4,$5::jsonb,$6) RETURNING *`,
      [req.body.name, JSON.stringify(req.body.condition_json), req.body.no_activity_hours, req.body.escalate_after_hours ?? null, JSON.stringify(req.body.action_json), req.body.is_active],
    );
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam, body: policySchema.partial() }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      const val = ['condition_json', 'action_json'].includes(k) ? JSON.stringify(v) : v;
      fields.push(`${k} = $${i}`); params.push(val); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE sla_policies SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE sla_policies SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

router.post('/:id/toggle', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `UPDATE sla_policies SET is_active = NOT is_active WHERE id = $1 RETURNING *`, [req.params.id]);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Alerts
router.get('/alerts', validate({ query: alertsQuery }), async (req, res, next) => {
  try {
    const conds = [];
    const params = [];
    if (req.query.user_id) { params.push(req.query.user_id); conds.push(`a.assigned_to = $${params.length}`); }
    if (req.query.status === 'open') conds.push('a.resolved_at IS NULL');
    if (req.query.status === 'resolved') conds.push('a.resolved_at IS NOT NULL');
    if (req.user.role === SYSTEM_TENANT_ROLES.COUNSELLOR) {
      params.push(req.user.id);
      conds.push(`a.assigned_to = $${params.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (req.query.page - 1) * req.query.limit;
    params.push(req.query.limit, offset);
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT a.*, l.name AS lead_name, p.name AS policy_name, u.name AS assigned_to_name
         FROM sla_alerts a
         LEFT JOIN leads l ON l.id = a.lead_id
         LEFT JOIN sla_policies p ON p.id = a.policy_id
         LEFT JOIN users u ON u.id = a.assigned_to
         ${where}
         ORDER BY a.flagged_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/alerts/:id/resolve', validate({ params: idParam, body: z.object({ reason: z.string().optional() }) }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `UPDATE sla_alerts SET resolved_at = now(), resolved_by = $2, resolution_reason = $3 WHERE id = $1 AND resolved_at IS NULL RETURNING *`,
      [req.params.id, req.user.id, req.body.reason ?? 'manual_resolve'],
    );
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.get('/alerts/summary', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT u.id, u.name, count(*)::int AS open_count
         FROM sla_alerts a LEFT JOIN users u ON u.id = a.assigned_to
        WHERE a.resolved_at IS NULL
        GROUP BY u.id, u.name ORDER BY open_count DESC`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
