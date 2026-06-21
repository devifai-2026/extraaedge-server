import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import { businessHoursSchema, holidaySchema, idParam, nextMomentQuery } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

router.get('/business-hours', controller.getHours);
router.put('/business-hours', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ body: businessHoursSchema }), controller.putHours);

router.get('/holidays', controller.listHolidays);
router.post('/holidays', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ body: holidaySchema }), controller.addHoliday);
router.delete('/holidays/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), controller.deleteHoliday);

router.get('/next-business-moment', validate({ query: nextMomentQuery }), controller.nextMoment);

export default router;
