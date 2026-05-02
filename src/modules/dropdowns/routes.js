import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import { typeParam, typeIdParam, itemCreateSchema, itemUpdateSchema, reorderSchema } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

router.get('/:type', validate({ params: typeParam }), controller.list);
router.post('/:type', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: typeParam, body: itemCreateSchema }), controller.create);
router.put('/:type/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: typeIdParam, body: itemUpdateSchema }), controller.update);
router.delete('/:type/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: typeIdParam }), controller.remove);
router.post('/:type/reorder', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: typeParam, body: reorderSchema }), controller.reorder);

export default router;
