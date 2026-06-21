import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { optimisticLock } from '../../middleware/optimisticLock.js';
import { SYSTEM_TENANT_ROLES, ADMIN_TIER_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import * as repo from './repo.js';
import { createUserSchema, updateUserSchema, idParam, listUsersQuery, resetPasswordSchema, changeUserPermissionsSchema, updateThemeSchema, updateAvatarSchema } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const loadUpdatedAt = async (req) => repo.getUpdatedAt(req.tenant, req.params.id);

// /users/team — before the :id routes so it doesn't match
router.get('/team', controller.myTeam);

// Update the current user's UI theme (3 brand colors). Open to every
// authenticated tenant role — each user manages their own theme. The
// route lives before /:id so the literal "me" doesn't match the UUID
// validator on the catch-all.
router.put('/me/theme', validate({ body: updateThemeSchema }), controller.updateMyTheme);

// Set / clear the current user's avatar. The actual image is uploaded
// via /uploads/presign + /uploads/confirm; this route only swaps the
// stored GCS key on the users row and returns a fresh signed URL for
// immediate render.
router.put('/me/avatar', validate({ body: updateAvatarSchema }), controller.updateMyAvatar);

// /users/org-tree — flat list of nodes + edges for the Org Tree canvas.
//   super_admin → entire tenant
//   sales_manager → full chain they're part of (managers above + team below)
//   counsellor → forbidden
router.get(
  '/org-tree',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER),
  controller.orgTree,
);

router.get('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ query: listUsersQuery }), controller.list);

router.get('/:id', validate({ params: idParam }), controller.get);

// Per-user lead views — used by the user-profile page.
//   /users/:id/leads?status=current  → leads currently assigned to this user
//   /users/:id/leads?status=past     → leads previously assigned (via lead_assignments)
router.get('/:id/leads', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), controller.userLeads);

// Per-user work sessions for the time-sheet table on the profile page.
router.get('/:id/work-sessions', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), controller.userWorkSessions);

// Per-user login/logout audit (driven by user_login_events, last 30 days).
router.get('/:id/login-events', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), controller.userLoginEvents);

// User CRUD is open to branch managers too, but the service layer scopes
// WHICH users they may touch to their own branch (their team subtree) and
// blocks them from creating/promoting super_admins or branch_managers — see
// users/service.js. The route gate only checks "is this a user-managing role".
router.post('/', requireRole(...ADMIN_TIER_ROLES), validate({ body: createUserSchema }), controller.create);

router.put(
  '/:id',
  requireRole(...ADMIN_TIER_ROLES),
  validate({ params: idParam, body: updateUserSchema }),
  optimisticLock(loadUpdatedAt),
  controller.update,
);

router.delete(
  '/:id',
  requireRole(...ADMIN_TIER_ROLES),
  validate({ params: idParam }),
  controller.remove,
);

router.post(
  '/:id/reset-password',
  requireRole(...ADMIN_TIER_ROLES),
  validate({ params: idParam, body: resetPasswordSchema }),
  controller.resetPassword,
);

// "Login as user" — org-admin ONLY, no password required. Returns the
// same shape as POST /auth/login so the FE can swap tokens with a
// single auth.setSession() call. See auth/service.sudoLoginAs.
// Deliberately NOT extended to branch_manager: impersonation is one of the
// two capabilities carved out of branch-manager access.
router.post(
  '/:id/sudo-login',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: idParam }),
  controller.sudoLogin,
);

router.put(
  '/:id/permissions',
  requireRole(...ADMIN_TIER_ROLES),
  validate({ params: idParam, body: changeUserPermissionsSchema }),
  controller.updatePermissions,
);

export default router;
