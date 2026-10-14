import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';
import { forbidden } from '../../lib/errors.js';
import { writeAuditLog } from '../../lib/auditLog.js';
import * as repo from './repo.js';
import * as usersRepo from '../users/repo.js';
import * as studentAuth from '../student-auth/service.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Dashboards: super_admin + branch_manager + head_trainer.
//
// head_trainer runs the trainer roster, so being unable to see trainer hours and
// course progress made the role unusable — it was the one manager barred from
// the numbers it is accountable for. Scoped to their own branch below, exactly
// like a branch_manager: this grants sight of their branch's LMS, not the
// tenant's. Sudo-login stays super_admin only.
const adminOrBranch = requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  LMS_TENANT_ROLES.HEAD_TRAINER,
);

// The branch to scope analytics to: branch_manager / head_trainer → their own
// branch (null branch → NO_BRANCH sentinel so they see an empty, not
// tenant-wide, view); super_admin → their picked branch (?branch_id) or null
// (all branches).
const NO_BRANCH = '00000000-0000-0000-0000-000000000000';
const BRANCH_SCOPED = [SYSTEM_TENANT_ROLES.BRANCH_MANAGER, LMS_TENANT_ROLES.HEAD_TRAINER];
const branchForActor = async (req) => {
  if (BRANCH_SCOPED.includes(req.user?.role)) {
    const me = await usersRepo.findById(req.tenant, req.user.id);
    return me?.branch_id ?? NO_BRANCH;
  }
  return req.query.branch_id || null; // super_admin
};

router.get('/dashboard', adminOrBranch, async (req, res, next) => {
  try {
    const b = await branchForActor(req);
    const [totals, funnel, courses, trainers] = await Promise.all([
      repo.totals(req.tenant, b), repo.funnel(req.tenant, b), repo.courseSummary(req.tenant, b), repo.trainerHours(req.tenant, b),
    ]);
    res.json({ data: { totals, funnel, courses, trainers }, meta: { requestId: req.id } });
  } catch (e) { next(e); }
});

// Students list for the sudo-login picker.
router.get('/students', adminOrBranch, async (req, res, next) => {
  try { res.json({ data: await repo.studentsForPicker(req.tenant, await branchForActor(req)), meta: { requestId: req.id } }); } catch (e) { next(e); }
});

// Sudo-login as a student — super_admin only (mirrors the staff sudo carve-out).
router.post('/students/:id/sudo-login',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: z.object({ id: z.string().uuid() }) }),
  async (req, res, next) => {
    try { res.json({ data: await studentAuth.sudoLoginAsStudent(req.tenant, req.params.id), meta: { requestId: req.id } }); } catch (e) { next(e); }
  });

// READ-ONLY student view-as — branch manager (and head_trainer, who already
// sees this branch's LMS numbers).
//
// Separate from the super_admin sudo-login above, and deliberately so: that
// one mints a full student session, this one mints a token carrying
// readOnly:true which studentReadOnly turns into a deny on every write. The
// BM sees exactly what the student sees and cannot submit a test, post to a
// forum or change a profile in their name.
//
// The target is re-checked against the actor's branch HERE rather than
// trusting the picker — the student id arrives from the client, and a
// branch-scoped list is a convenience, not a gate. super_admin skips the
// check because branchForActor returns null for them (tenant-wide by design).
router.post('/students/:id/view-as',
  adminOrBranch,
  validate({ params: z.object({ id: z.string().uuid() }) }),
  async (req, res, next) => {
    try {
      const branchId = await branchForActor(req);
      if (branchId && !(await repo.isStudentInBranch(req.tenant, req.params.id, branchId))) {
        throw forbidden('Student is outside your branch');
      }
      const data = await studentAuth.viewAsStudent(req.tenant, req.params.id);
      // Audited like any other look at someone else's screens. Attributed to
      // the actor, never to the student.
      await writeAuditLog(req.tenant, {
        userId: req.user.id,
        action: 'student.view_as',
        entityType: 'student',
        entityId: req.params.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      res.json({ data, meta: { requestId: req.id } });
    } catch (e) { next(e); }
  });

export default router;
