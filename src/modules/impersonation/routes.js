import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import { startImpersonationSchema, listQuery } from './schema.js';

const router = express.Router();
router.use(authRequired);

router.post('/start',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER, PLATFORM_ROLES.SUPPORT_ADMIN),
  validate({ body: startImpersonationSchema }),
  controller.start);

router.post('/stop', controller.stop); // authed impersonating user

router.get('/sessions',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER),
  validate({ query: listQuery }),
  controller.list);

export default router;
