import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { optimisticLock } from '../../middleware/optimisticLock.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import * as repo from './repo.js';
import { createTeamSchema, updateTeamSchema, idParam, memberParam, addMemberSchema } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const loadUpdatedAt = async (req) => repo.getUpdatedAt(req.tenant, req.params.id);

router.get('/', controller.list);
router.get('/:id', validate({ params: idParam }), controller.get);
router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: createTeamSchema }), controller.create);
router.put(
  '/:id',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: idParam, body: updateTeamSchema }),
  optimisticLock(loadUpdatedAt),
  controller.update,
);
router.delete('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam }), controller.remove);

router.get('/:id/members', validate({ params: idParam }), controller.listMembers);
router.post('/:id/members', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: idParam, body: addMemberSchema }), controller.addMember);
router.delete('/:id/members/:user_id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER), validate({ params: memberParam }), controller.removeMember);
router.get('/:id/leads', validate({ params: idParam }), controller.listLeads);

export default router;
