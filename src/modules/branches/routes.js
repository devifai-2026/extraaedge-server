import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { optimisticLock } from '../../middleware/optimisticLock.js';
import { SYSTEM_TENANT_ROLES, ADMIN_TIER_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import * as repo from './repo.js';
import { idParam, createBranchSchema, updateBranchSchema, assignUserSchema } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const loadUpdatedAt = async (req) => repo.getUpdatedAt(req.tenant, req.params.id);

// Reading the branch list is open to managers + admins (e.g. to populate a
// branch picker). Branch CRUD is admin-tier (super_admin + branch_manager),
// matching teams. Only super_admin should create branches / set the head;
// branch_manager managing branch structure is allowed but they can't make
// themselves head of a new branch they don't already run — enforced by the
// one-branch-per-manager constraint + role check in the service.
router.get(
  '/',
  requireRole(
    SYSTEM_TENANT_ROLES.SUPER_ADMIN,
    SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
    SYSTEM_TENANT_ROLES.SALES_MANAGER,
  ),
  controller.list,
);

router.get('/:id', requireRole(...ADMIN_TIER_ROLES), validate({ params: idParam }), controller.get);

// Mutations: super_admin only — branches are a tenant-structure concern, like
// creating teams/users. (Branch managers run a branch; they don't define the
// branch map.)
router.post(
  '/',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ body: createBranchSchema }),
  controller.create,
);

// First-run onboarding: create the first branch AND move all existing users +
// leads into it in one call. super_admin only.
router.post(
  '/adopt-all',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ body: createBranchSchema }),
  controller.adoptAll,
);

router.put(
  '/:id',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: idParam, body: updateBranchSchema }),
  optimisticLock(loadUpdatedAt),
  controller.update,
);

router.delete(
  '/:id',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: idParam }),
  controller.remove,
);

// Move a user into / out of a branch.
router.post(
  '/:id/members',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: idParam, body: assignUserSchema }),
  controller.assignUser,
);

router.delete(
  '/:id/members/:user_id',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: z.object({ id: z.string().uuid(), user_id: z.string().uuid() }) }),
  controller.unassignUser,
);

export default router;
