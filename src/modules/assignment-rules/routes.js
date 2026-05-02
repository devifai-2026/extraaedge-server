import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { notFound } from '../../lib/errors.js';
import { evaluateCondition } from '../../services/rule-engine.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const ruleSchema = z.object({
  name: z.string().min(1),
  priority: z.coerce.number().int().default(100),
  condition_json: z.record(z.string(), z.any()).default({}),
  strategy: z.enum(['round_robin', 'load_balanced', 'by_geography', 'by_program', 'specific_user', 'team_round_robin']),
  target_users: z.array(z.string().uuid()).optional(),
  target_team_id: z.string().uuid().optional(),
  fallback_user_id: z.string().uuid().optional(),
  respect_working_hours: z.boolean().default(true),
  skip_unavailable: z.boolean().default(true),
  is_active: z.boolean().default(true),
});
const idParam = z.object({ id: z.string().uuid() });

router.get('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT r.*, s.last_assigned_user_id, s.total_assignments FROM assignment_rules r
         LEFT JOIN assignment_rule_state s ON s.rule_id = r.id
        WHERE r.deleted_at IS NULL ORDER BY r.priority, r.name`,
    );
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: ruleSchema }), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(
      req.tenant,
      `INSERT INTO assignment_rules (name, priority, condition_json, strategy, target_users, target_team_id, fallback_user_id, respect_working_hours, skip_unavailable, is_active)
       VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.body.name, req.body.priority, JSON.stringify(req.body.condition_json), req.body.strategy, req.body.target_users ?? null, req.body.target_team_id ?? null, req.body.fallback_user_id ?? null, req.body.respect_working_hours, req.body.skip_unavailable, req.body.is_active],
    );
    await tenantQuery(req.tenant, `INSERT INTO assignment_rule_state (rule_id) VALUES ($1) ON CONFLICT DO NOTHING`, [rows[0].id]);
    res.status(201).json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam, body: ruleSchema.partial() }), async (req, res, next) => {
  try {
    const fields = []; const params = []; let i = 1;
    for (const [k, v] of Object.entries(req.body)) {
      if (v === undefined) continue;
      const val = k === 'condition_json' ? JSON.stringify(v) : v;
      fields.push(`${k} = $${i}`); params.push(val); i += 1;
    }
    params.push(req.params.id);
    const { rows } = await tenantQuery(req.tenant, `UPDATE assignment_rules SET ${fields.join(', ')} WHERE id = $${i} AND deleted_at IS NULL RETURNING *`, params);
    res.json({ data: rows[0], meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.delete('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam }), async (req, res, next) => {
  try { await tenantQuery(req.tenant, `UPDATE assignment_rules SET deleted_at = now() WHERE id = $1`, [req.params.id]); res.status(204).end(); }
  catch (err) { next(err); }
});

// Test a rule against a specific lead (dry run)
router.post('/:id/test', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: z.object({ lead_id: z.string().uuid() }) }), async (req, res, next) => {
  try {
    const { rows: [rule] } = await tenantQuery(req.tenant, `SELECT * FROM assignment_rules WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!rule) throw notFound('Rule not found');
    const { rows: [lead] } = await tenantQuery(req.tenant, `SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL`, [req.body.lead_id]);
    if (!lead) throw notFound('Lead not found');
    const matched = evaluateCondition(rule.condition_json, { lead });
    res.json({ data: { matched, rule_name: rule.name, strategy: rule.strategy }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
