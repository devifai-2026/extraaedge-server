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
// Optional, nullable, length-capped text — a blank string clears the field.
const optText = (max) => z.string().max(max).nullable().optional();

const brandingSchema = z.object({
  logo_r2_key: z.string().min(1).nullable().optional(),
  brand_name: z.string().max(120).optional(),
  brand_primary_color: z.string().max(20).optional(),
  brand_secondary_color: z.string().max(20).optional(),
  // Organisation contact block shown on the fee-receipt header. Tenant-editable
  // by the super_admin; the columns already exist on tenants.
  phone: optText(40),
  website: optText(200),
  email: optText(200),
  address_line1: optText(200),
  address_line2: optText(200),
  city: optText(120),
  state: optText(120),
  pincode: optText(20),
  // Fee-receipt config (see tenant_receipt_config migration). All optional so
  // this one endpoint serves both logo and receipt settings.
  receipt_terms: z.array(z.string().max(300)).max(6).optional(),
  receipt_signatory_label: z.string().max(80).optional(),
  receipt_thankyou: optText(200),
  receipt_no_prefix: z.string().max(40).nullable().optional(),
  receipt_no_start: z.number().int().min(1).max(9_999_999_999).optional(),
  receipt_no_pad: z.number().int().min(1).max(12).optional(),
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
          phone: row.phone ?? null,
          website: row.website ?? null,
          email: row.email ?? null,
          address_line1: row.address_line1 ?? null,
          address_line2: row.address_line2 ?? null,
          city: row.city ?? null,
          state: row.state ?? null,
          pincode: row.pincode ?? null,
          receipt_terms: Array.isArray(row.receipt_terms) ? row.receipt_terms : [],
          receipt_signatory_label: row.receipt_signatory_label ?? null,
          receipt_thankyou: row.receipt_thankyou ?? null,
          receipt_no_prefix: row.receipt_no_prefix ?? null,
          receipt_no_start: row.receipt_no_start ?? null,
          receipt_no_pad: row.receipt_no_pad ?? null,
        },
        meta: { requestId: req.id },
      });
    } catch (err) { next(err); }
  },
);

export default router;
