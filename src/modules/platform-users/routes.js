import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import { createPlatformUserSchema, updatePlatformUserSchema, platformUserIdParam } from './schema.js';

const router = express.Router();
router.use(authRequired, requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER));

router.get('/', controller.list);
router.post('/', validate({ body: createPlatformUserSchema }), controller.create);
router.put('/:id', validate({ params: platformUserIdParam, body: updatePlatformUserSchema }), controller.update);
router.delete('/:id', validate({ params: platformUserIdParam }), controller.remove);

export default router;
