// Cross-tenant lead inspector for the product_owner. Read-only drill-down into
// any tenant's lead: full details + timeline (creation, reassigns, followups)
// and the tenant's bulk-import status/failures. PRODUCT_OWNER only — this
// exposes raw tenant PII across tenants.
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import * as repo from './repo.js';

const router = express.Router();
router.use(authRequired, requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER));

const tenantParam = z.object({ tenantId: z.string().uuid() });
const tenantLeadParam = tenantParam.extend({ leadId: z.string().uuid() });
const tenantImportParam = tenantParam.extend({ importId: z.string().uuid() });
const searchQuery = z.object({ q: z.string().optional(), limit: z.coerce.number().int().min(1).max(100).optional() });

// Search leads within a tenant.
router.get('/:tenantId/leads', validate({ params: tenantParam, query: searchQuery }), async (req, res, next) => {
  try {
    const rows = await repo.searchLeads(req.params.tenantId, req.query);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Full lead picture (details + timeline).
router.get('/:tenantId/leads/:leadId', validate({ params: tenantLeadParam }), async (req, res, next) => {
  try {
    const data = await repo.getLeadFull(req.params.tenantId, req.params.leadId);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// Bulk imports for a tenant.
router.get('/:tenantId/bulk-imports', validate({ params: tenantParam, query: z.object({ limit: z.coerce.number().int().min(1).max(200).optional() }) }), async (req, res, next) => {
  try {
    const data = await repo.listBulkImports(req.params.tenantId, req.query);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

// One bulk import + its failures.
router.get('/:tenantId/bulk-imports/:importId', validate({ params: tenantImportParam }), async (req, res, next) => {
  try {
    const data = await repo.getBulkImport(req.params.tenantId, req.params.importId);
    res.json({ data, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
