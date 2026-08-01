import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import {
  startImpersonationSchema, startTenantAdminSchema, exchangeHandoffSchema, listQuery,
} from './schema.js';

const router = express.Router();

// Handoff redemption is deliberately BEFORE authRequired: the admin app calls
// it with no session of its own — the single-use, short-lived code minted by
// /tenant-admin is the credential. See service.exchangeHandoff.
router.post('/exchange', validate({ body: exchangeHandoffSchema }), controller.exchange);

router.use(authRequired);

router.post('/start',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER, PLATFORM_ROLES.SUPPORT_ADMIN),
  validate({ body: startImpersonationSchema }),
  controller.start);

// One-click "open this tenant's admin console as their super admin".
router.post('/tenant-admin',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER, PLATFORM_ROLES.SUPPORT_ADMIN),
  validate({ body: startTenantAdminSchema }),
  controller.startTenantAdmin);

router.post('/stop', controller.stop); // authed impersonating user

router.get('/sessions',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER),
  validate({ query: listQuery }),
  controller.list);

export default router;
