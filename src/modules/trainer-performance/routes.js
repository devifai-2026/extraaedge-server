import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';
import * as service from './service.js';

const router = express.Router();
const ok = (res, req, data, status = 200) => res.status(status).json({ data, meta: { requestId: req.id } });

router.use(authRequired, tenantRequired, requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  LMS_TENANT_ROLES.HEAD_TRAINER, LMS_TENANT_ROLES.TRAINER,
));

// A trainer reaching either endpoint is confined to their own rows by the
// service, so the filters below are only meaningful for the manager tier.
const filters = z.object({
  trainer_id: z.string().uuid().optional(),
  program_id: z.string().uuid().optional(),
  module: z.string().max(200).optional(),
  trainer: z.string().max(200).optional(),
}).optional();

router.get('/', validate({ query: filters }), async (req, res, next) => {
  try {
    ok(res, req, {
      rows: await service.report(req.tenant, req.user, req.query),
      can_see_everyone: service.canSeeEveryone(req.user),
    });
  } catch (e) { next(e); }
});

router.get('/summary', validate({ query: filters }), async (req, res, next) => {
  try { ok(res, req, await service.summary(req.tenant, req.user, req.query)); } catch (e) { next(e); }
});

export default router;
