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

const configSchema = z.object({
  name: z.string().min(1),
  criterion: z.string().optional(),
  condition_json: z.record(z.string(), z.any()).default({}),
  points: z.coerce.number().int(),
  is_active: z.boolean().default(true),
});

router.get('/config', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM lead_score_config WHERE deleted_at IS NULL ORDER BY name`);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/config', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: z.array(configSchema) }), async (req, res, next) => {
  try {
    // Replace-all semantics: soft-delete existing active entries, then insert.
    await tenantQuery(req.tenant, `UPDATE lead_score_config SET deleted_at = now() WHERE deleted_at IS NULL`);
    for (const c of req.body) {
      await tenantQuery(
        req.tenant,
        `INSERT INTO lead_score_config (name, criterion, condition_json, points, is_active)
         VALUES ($1,$2,$3::jsonb,$4,$5)`,
        [c.name, c.criterion ?? null, JSON.stringify(c.condition_json), c.points, c.is_active],
      );
    }
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM lead_score_config WHERE deleted_at IS NULL ORDER BY name`);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Dry-run against a lead: returns the score contribution of every active criterion.
router.post('/test', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ body: z.object({ lead_id: z.string().uuid() }) }), async (req, res, next) => {
  try {
    const { rows: [lead] } = await tenantQuery(req.tenant, `SELECT * FROM leads WHERE id = $1 AND deleted_at IS NULL`, [req.body.lead_id]);
    if (!lead) throw notFound('Lead not found');
    const { rows: configs } = await tenantQuery(req.tenant, `SELECT * FROM lead_score_config WHERE deleted_at IS NULL AND is_active = true`);
    const breakdown = [];
    let total = 0;
    for (const c of configs) {
      const match = evaluateCondition(c.condition_json, { lead });
      if (match) {
        total += Number(c.points);
        breakdown.push({ name: c.name, criterion: c.criterion, points: c.points, matched: true });
      } else {
        breakdown.push({ name: c.name, criterion: c.criterion, points: 0, matched: false });
      }
    }
    if (lead.lead_score_manual_override !== null && lead.lead_score_manual_override !== undefined) {
      total = Number(lead.lead_score_manual_override);
    }
    res.json({ data: { total, breakdown }, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
