import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import { tenantCreateSchema, tenantUpdateSchema, tenantListQuery, tenantIdParam } from './schema.js';

const router = express.Router();

router.use(authRequired);

router.post('/',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER),
  validate({ body: tenantCreateSchema }),
  controller.create);

router.get('/',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER, PLATFORM_ROLES.SUPPORT_ADMIN),
  validate({ query: tenantListQuery }),
  controller.list);

router.get('/:id',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER, PLATFORM_ROLES.SUPPORT_ADMIN),
  validate({ params: tenantIdParam }),
  controller.getOne);

router.put('/:id',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER),
  validate({ params: tenantIdParam, body: tenantUpdateSchema }),
  controller.update);

router.post('/:id/suspend',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER),
  validate({ params: tenantIdParam }),
  controller.suspend);

router.post('/:id/resume',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER),
  validate({ params: tenantIdParam }),
  controller.resume);

// Soft-delete the tenant. Marks deleted_at + sets status='suspended' so the
// tenant immediately stops being usable. The underlying tenant_<slug> database
// is kept for now (recovery / audit). Hard-delete would need a separate flow
// with a strong confirmation since it drops a whole DB.
router.delete('/:id',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER),
  validate({ params: tenantIdParam }),
  controller.remove);

export default router;
