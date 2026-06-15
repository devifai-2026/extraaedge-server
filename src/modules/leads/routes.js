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
import { leadCreateSchema, leadUpdateSchema, listQuery, idParam, stageChangeSchema, bulkAssignSchema, bulkDeleteSchema } from './schema.js';

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
// Full CSV export of the lead list — NO pagination, every matching row.
// Super-admin ONLY (the FE hides the button for other roles; we enforce here
// because the FE check is just a hint). Honors the same filter query params
// as GET /leads so the download matches the on-screen list. Declared before
// the '/:id' route so 'export.csv' isn't swallowed as an :id param.
router.get(
  '/export.csv',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ query: listQuery }),
  controller.exportCsv,
);
// stage-counts honors the same advanced-filter query params as /leads so the
// tab labels update when the user applies a filter in the LeadList.
router.get('/stage-counts', validate({ query: listQuery }), controller.stageCounts);
router.post('/bulk-assign', validate({ body: bulkAssignSchema }), controller.bulkAssign);

// Bulk hard-delete. Super-admin ONLY — counsellors / managers don't even
// see the button on the FE, but we enforce here too because the FE check
// is just a hint, not a security boundary. FK CASCADEs at the schema layer
// guarantee follow-ups, notes, activities, assignments, family, attribution,
// custom values, tags, calls, recordings, payments and referral edges are
// physically removed alongside the lead row.
router.post(
  '/bulk-delete',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ body: bulkDeleteSchema }),
  controller.bulkDelete,
);
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
