// Danger Request Log — full cross-tenant API activity for the product_owner.
// Read-only. Gated to PRODUCT_OWNER (the deepest-access platform role); the
// payloads here can contain tenant PII so support_admin is intentionally
// excluded.
import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import { listQuery, idParam } from './schema.js';

const router = express.Router();
router.use(authRequired, requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER));

router.get('/facets', controller.facets);
router.get('/metrics', controller.metrics);
router.get('/', validate({ query: listQuery }), controller.list);
router.get('/:id', validate({ params: idParam }), controller.detail);

export default router;
