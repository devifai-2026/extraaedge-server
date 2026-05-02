// Platform audit log — HTTP wiring only.
import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import { listQuery } from './schema.js';

const router = express.Router();
router.use(authRequired, requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER, PLATFORM_ROLES.SUPPORT_ADMIN));

router.get('/', validate({ query: listQuery }), controller.list);

export default router;
