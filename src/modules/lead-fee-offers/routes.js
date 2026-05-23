import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import { upsertOfferSchema, leadIdParam } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Accounts module: account_manager + super_admin only. Mirrors the
// admissions router gating so the same people who handle pending
// admissions configure the fee offer.
router.use(requireRole(
  SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER,
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
));

router.get('/:leadId', validate({ params: leadIdParam }), controller.get);
router.put(
  '/:leadId',
  validate({ params: leadIdParam, body: upsertOfferSchema }),
  controller.upsert,
);

export default router;
