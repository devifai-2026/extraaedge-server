import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { optimisticLock } from '../../middleware/optimisticLock.js';
import { requireRole } from '../../middleware/rbac.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import * as service from './service.js';
import { leadCreateSchema, leadUpdateSchema, listQuery, idParam, stageChangeSchema } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

router.get('/', validate({ query: listQuery }), controller.list);
router.get('/:id', validate({ params: idParam }), controller.get);
router.get('/:id/timeline', validate({ params: idParam }), controller.timeline);

router.post('/', validate({ body: leadCreateSchema }), controller.create);

router.put(
  '/:id',
  validate({ params: idParam, body: leadUpdateSchema }),
  optimisticLock(service.updatedAtLoader),
  controller.update,
);

router.delete(
  '/:id',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: idParam }),
  controller.remove,
);

router.post(
  '/:id/stage',
  validate({ params: idParam, body: stageChangeSchema }),
  controller.changeStage,
);

export default router;
