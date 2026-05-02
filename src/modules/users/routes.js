import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { optimisticLock } from '../../middleware/optimisticLock.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import * as repo from './repo.js';
import { createUserSchema, updateUserSchema, idParam, listUsersQuery, resetPasswordSchema, changeUserPermissionsSchema } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const loadUpdatedAt = async (req) => repo.getUpdatedAt(req.tenant, req.params.id);

// /users/team — before the :id routes so it doesn't match
router.get('/team', controller.myTeam);

// /users/org-tree — flat list of nodes + edges for the Org Tree canvas.
//   super_admin → entire tenant
//   sales_manager → full chain they're part of (managers above + team below)
//   counsellor → forbidden
router.get(
  '/org-tree',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER),
  controller.orgTree,
);

router.get('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ query: listUsersQuery }), controller.list);

router.get('/:id', validate({ params: idParam }), controller.get);

// Per-user lead views — used by the user-profile page.
//   /users/:id/leads?status=current  → leads currently assigned to this user
//   /users/:id/leads?status=past     → leads previously assigned (via lead_assignments)
router.get('/:id/leads', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), controller.userLeads);

// Per-user work sessions for the time-sheet table on the profile page.
router.get('/:id/work-sessions', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), controller.userWorkSessions);

// Per-user login/logout audit (driven by user_login_events, last 30 days).
router.get('/:id/login-events', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam }), controller.userLoginEvents);

router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: createUserSchema }), controller.create);

router.put(
  '/:id',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: idParam, body: updateUserSchema }),
  optimisticLock(loadUpdatedAt),
  controller.update,
);

router.delete(
  '/:id',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: idParam }),
  controller.remove,
);

router.post(
  '/:id/reset-password',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: idParam, body: resetPasswordSchema }),
  controller.resetPassword,
);

router.put(
  '/:id/permissions',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: idParam, body: changeUserPermissionsSchema }),
  controller.updatePermissions,
);

export default router;
