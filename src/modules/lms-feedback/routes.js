import express from 'express';
import { z } from 'zod';
import { authRequired, studentAuthRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES, ADMIN_TIER_ROLES } from '../../config/constants.js';
import * as repo from './repo.js';

const router = express.Router();
const ok = (res, req, data, status = 200) => res.status(status).json({ data, meta: { requestId: req.id } });

// ---- Staff view of submitted feedback ----
// Declared BEFORE the student chain below, which would otherwise swallow these
// paths with a student-auth 401 for staff callers.
const staff = express.Router();
staff.use(authRequired, tenantRequired, requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  LMS_TENANT_ROLES.HEAD_TRAINER, LMS_TENANT_ROLES.TRAINER,
));
staff.get('/', validate({
  query: z.object({
    trainer_id: z.string().uuid().optional(),
    program_id: z.string().uuid().optional(),
    scope: z.enum(['class', 'module']).optional(),
  }).optional(),
}), async (req, res, next) => {
  try {
    // A plain trainer sees only feedback about themselves; the manager tier and
    // the head trainer (the "trainer lead") see everyone's and can filter.
    const wide = [...ADMIN_TIER_ROLES, LMS_TENANT_ROLES.HEAD_TRAINER].includes(req.user.role);
    ok(res, req, {
      rows: await repo.staffList(req.tenant, {
        trainerId: wide ? (req.query?.trainer_id || null) : req.user.id,
        programId: req.query?.program_id || null,
        scope: req.query?.scope || null,
      }),
      can_see_everyone: wide,
    });
  } catch (e) { next(e); }
});
router.use('/staff', staff);

// ---- Student principal: give feedback ----
router.use(studentAuthRequired, tenantRequired);

// What this student still owes. Drives the blocking modal in the portal.
router.get('/pending', async (req, res, next) => {
  try { ok(res, req, await repo.pending(req.tenant, req.student.id)); } catch (e) { next(e); }
});

const body = z.object({
  scope: z.enum(['class', 'module']),
  class_id: z.string().uuid().optional(),
  module_id: z.string().uuid().optional(),
  rating: z.number().int().min(1).max(5),
  pace_rating: z.number().int().min(1).max(5).optional(),
  clarity_rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().max(2000).optional(),
});

router.post('/', validate({ body }), async (req, res, next) => {
  try { ok(res, req, await repo.submit(req.tenant, req.student.id, req.body), 201); } catch (e) { next(e); }
});

// "Not now." Counted, and the prompt returns next login until submitted.
router.post('/dismiss', validate({
  body: z.object({
    scope: z.enum(['class', 'module']),
    class_id: z.string().uuid().optional(),
    module_id: z.string().uuid().optional(),
  }),
}), async (req, res, next) => {
  try { ok(res, req, await repo.dismiss(req.tenant, req.student.id, req.body)); } catch (e) { next(e); }
});

export default router;
