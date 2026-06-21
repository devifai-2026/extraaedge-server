import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES, MANAGER_TIER_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import { leadIdParam, applyDiscountSchema, decideDiscountSchema } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Managers who can approve/reject discounts and see the pending queue:
// super_admin + branch_manager + sales_manager.
const managerRoles = requireRole(...MANAGER_TIER_ROLES);

// Roles that can READ a lead's discount. Counsellors + managers see it on the
// lead; account_manager (Accounts team) sees it on the converted lead so the
// agreed discount is visible when configuring the fee offer.
const readRoles = requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  SYSTEM_TENANT_ROLES.SALES_MANAGER,
  SYSTEM_TENANT_ROLES.COUNSELLOR,
  SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER,
);

// Pending-approval queue for the acting manager. Declared before '/:leadId'
// so the literal 'pending' isn't captured as a leadId.
router.get('/pending', managerRoles, controller.pending);

router.get('/:leadId', readRoles, validate({ params: leadIdParam }), controller.get);

// Apply / request a discount. Counsellors + managers (NOT account_manager —
// the Accounts team consumes the discount, it doesn't set it). The service
// decides auto-approve (<=cap or manager actor) vs pending_approval.
router.post(
  '/:leadId',
  requireRole(
    SYSTEM_TENANT_ROLES.SUPER_ADMIN,
    SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
    SYSTEM_TENANT_ROLES.SALES_MANAGER,
    SYSTEM_TENANT_ROLES.COUNSELLOR,
  ),
  validate({ params: leadIdParam, body: applyDiscountSchema }),
  controller.apply,
);

// Approve / reject a pending discount — managers only.
router.post(
  '/:leadId/decide',
  managerRoles,
  validate({ params: leadIdParam, body: decideDiscountSchema }),
  controller.decide,
);

export default router;
