import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { optimisticLock } from '../../middleware/optimisticLock.js';
import { requireRole } from '../../middleware/rbac.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import { tenantQuery } from '../../db/tenant.js';
import { forbidden, notFound } from '../../lib/errors.js';
import * as controller from './controller.js';
import * as service from './service.js';
import { leadCreateSchema, leadUpdateSchema, listQuery, idParam, stageChangeSchema, bulkAssignSchema } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Once a lead has been converted (stage flagged is_success → converted_at set)
// the row is effectively closed. Only super_admin can keep editing it; everyone
// else gets a 403. Applies to both PUT /leads/:id and POST /leads/:id/stage.
const blockEditIfConverted = async (req, _res, next) => {
  try {
    if (req.user.role === SYSTEM_TENANT_ROLES.SUPER_ADMIN) return next();
    const { rows } = await tenantQuery(
      req.tenant,
      `SELECT converted_at FROM leads WHERE id = $1 AND deleted_at IS NULL`,
      [req.params.id],
    );
    if (!rows.length) return next(notFound('Lead not found'));
    if (rows[0].converted_at) {
      return next(forbidden('This lead has been converted and can only be edited by an administrator.'));
    }
    return next();
  } catch (err) { return next(err); }
};

// Bulk auto-assign — runs the active assignment rule against every unassigned
// lead in the tenant. Admins / managers only; counsellors don't get the button.
router.post(
  '/auto-assign-unassigned',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.SALES_MANAGER),
  controller.autoAssignUnassigned,
);

router.get('/', validate({ query: listQuery }), controller.list);
router.get('/stage-counts', controller.stageCounts);
router.post('/bulk-assign', validate({ body: bulkAssignSchema }), controller.bulkAssign);
router.get('/:id', validate({ params: idParam }), controller.get);
router.get('/:id/timeline', validate({ params: idParam }), controller.timeline);

router.post('/', validate({ body: leadCreateSchema }), controller.create);

router.put(
  '/:id',
  validate({ params: idParam, body: leadUpdateSchema }),
  blockEditIfConverted,
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
  blockEditIfConverted,
  controller.changeStage,
);

export default router;
