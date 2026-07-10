import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import * as service from './service.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Tenant self-branding — super_admin only. `logo_r2_key` comes from a prior
// /uploads presign+confirm (purpose 'tenant_logo'); pass null to clear the
// logo. Optional brand_name / colors pass through.
const brandingSchema = z.object({
  logo_r2_key: z.string().min(1).nullable().optional(),
  brand_name: z.string().max(120).optional(),
  brand_primary_color: z.string().max(20).optional(),
  brand_secondary_color: z.string().max(20).optional(),
});

router.put(
  '/',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ body: brandingSchema }),
  async (req, res, next) => {
    try {
      const row = await service.updateBranding(req.tenant, req.body);
      res.json({
        data: {
          logo_url: row.logo_url ?? null,
          brand_name: row.brand_name ?? null,
          brand_primary_color: row.brand_primary_color ?? null,
          brand_secondary_color: row.brand_secondary_color ?? null,
        },
        meta: { requestId: req.id },
      });
    } catch (err) { next(err); }
  },
);

export default router;
