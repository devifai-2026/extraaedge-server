import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery, tenantTx } from '../../db/tenant.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const PERM = z.enum(['hidden', 'readonly', 'readwrite']);
const ENTITY = z.enum(['lead', 'user', 'program']);
const bodySchema = z.array(z.object({
  role_id: z.string().uuid().optional(),
  role: z.string().optional(),
  entity: ENTITY,
  field: z.string().min(1),
  permission: PERM,
}));

router.get('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), async (req, res, next) => {
  try {
    const { rows } = await tenantQuery(req.tenant, `SELECT * FROM field_permissions ORDER BY entity, field`);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

router.put('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: bodySchema }), async (req, res, next) => {
  try {
    const result = await tenantTx(req.tenant, async (client) => {
      const saved = [];
      for (const rule of req.body) {
        const { rows } = await client.query(
          `INSERT INTO field_permissions (role_id, role, entity, field, permission)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (COALESCE(role_id::text, ''), role, entity, field) DO UPDATE SET permission = EXCLUDED.permission, updated_at = now()
           RETURNING *`,
          [rule.role_id ?? null, rule.role ?? null, rule.entity, rule.field, rule.permission],
        );
        saved.push(rows[0]);
      }
      return saved;
    });
    res.json({ data: result, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// What can the current user see/edit?
router.get('/effective', async (req, res, next) => {
  try {
    const params = [req.user.id];
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT fp.entity, fp.field, fp.permission
         FROM field_permissions fp
         LEFT JOIN users u ON u.id = $1
        WHERE fp.role_id = u.role_id OR fp.role = u.role`,
      params,
    );
    // Collapse to a nested shape for the FE form renderer: { lead: { email: 'readonly', ... }, ... }
    const out = {};
    for (const r of rows) {
      out[r.entity] = out[r.entity] ?? {};
      out[r.entity][r.field] = r.permission;
    }
    res.json({ data: out, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
