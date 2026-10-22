import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { requirePlatformRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { PLATFORM_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import {
  tenantCreateSchema, tenantUpdateSchema, tenantListQuery, tenantIdParam,
  authModeSchema, tenantAdminPasswordSchema,
} from './schema.js';

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

// Org hierarchy of the tenant — owner → managers → counsellors.
// Returned as a tree for direct rendering by the product-owner UI.
router.get('/:id/org-tree',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER, PLATFORM_ROLES.SUPPORT_ADMIN),
  validate({ params: tenantIdParam }),
  controller.orgTree);

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

// ---- Login mode + the tenant admin's password -------------------------
// PRODUCT_OWNER only (not SUPPORT_ADMIN): both change who can get into a
// customer's account, which is a different class of action from reading a
// tenant's details.

router.put('/:id/auth-mode',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER),
  validate({ params: tenantIdParam, body: authModeSchema }),
  controller.setAuthMode);

router.get('/:id/admin',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER),
  validate({ params: tenantIdParam }),
  controller.getAdmin);

// POST, not PUT: each call MINTS a new password rather than putting a known
// value, so it is not idempotent — repeating it gives a different result.
router.post('/:id/admin/password',
  requirePlatformRole(PLATFORM_ROLES.PRODUCT_OWNER),
  validate({ params: tenantIdParam, body: tenantAdminPasswordSchema }),
  controller.setAdminPassword);

export default router;
