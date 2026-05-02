import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { optimisticLock } from '../../middleware/optimisticLock.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import * as repo from './repo.js';
import { createProgramSchema, updateProgramSchema, idParam, listQuery } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

router.get('/', validate({ query: listQuery }), controller.list);
router.get('/:id', validate({ params: idParam }), controller.get);
router.post('/', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: createProgramSchema }), controller.create);
router.put(
  '/:id',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: idParam, body: updateProgramSchema }),
  optimisticLock(async (req) => repo.getUpdatedAt(req.tenant, req.params.id)),
  controller.update,
);
router.delete('/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam }), controller.remove);

export default router;
