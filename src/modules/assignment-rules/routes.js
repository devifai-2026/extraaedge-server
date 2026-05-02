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

// Create + delete are intentionally disabled. Each tenant has exactly 6 fixed
// rule templates (one per strategy) seeded on provisioning. Admins choose
// which one is active and can tweak its targets/condition. We return 405 with
// a friendly hint so direct API consumers know why.
router.post('/', (_req, res) => {
  res.status(405).json({
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: 'Each tenant has 6 fixed rule templates. Edit one of them instead of creating a new rule.',
    },
  });
});
router.delete('/:id', (_req, res) => {
  res.status(405).json({
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: 'Rule templates cannot be deleted. Toggle is_active=false to disable a rule.',
    },
  });
});

// Edit a rule. Enforces "at most 1 active rule per tenant" — flipping
// is_active=true on one rule auto-deactivates every other rule.
router.put('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam, body: ruleSchema.partial() }), async (req, res, next) => {
  try {
    if (req.body.is_active === true) {
      // Deactivate every other rule in this tenant before activating this one.
      // Single-tx via two queries is fine — the rule-processor only reads
      // the active subset and tolerates a sub-millisecond gap.
      await tenantQuery(
        req.tenant,
        `UPDATE assignment_rules SET is_active = false WHERE id <> $1 AND deleted_at IS NULL`,
        [req.params.id],
      );
    }
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
