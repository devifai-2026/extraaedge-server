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

// account_manager + super_admin handle any lead's fee offer. Counsellors may
// also configure the offer — but ONLY for their own leads (enforced in the
// service by checking leads.assigned_to === actor.id), so they can complete
// the "configure + send admission link" flow for students they converted.
router.use(requireRole(
  SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER,
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.COUNSELLOR,
));

router.get('/:leadId', validate({ params: leadIdParam }), controller.get);
router.put(
  '/:leadId',
  validate({ params: leadIdParam, body: upsertOfferSchema }),
  controller.upsert,
);

export default router;
