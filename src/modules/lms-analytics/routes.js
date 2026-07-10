import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import * as repo from './repo.js';
import * as studentAuth from '../student-auth/service.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Dashboards: super_admin + branch_manager.
const adminOrBranch = requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER);

router.get('/dashboard', adminOrBranch, async (req, res, next) => {
  try {
    const [totals, funnel, courses, trainers] = await Promise.all([
      repo.totals(req.tenant), repo.funnel(req.tenant), repo.courseSummary(req.tenant), repo.trainerHours(req.tenant),
    ]);
    res.json({ data: { totals, funnel, courses, trainers }, meta: { requestId: req.id } });
  } catch (e) { next(e); }
});

// Students list for the sudo-login picker.
router.get('/students', adminOrBranch, async (req, res, next) => {
  try { res.json({ data: await repo.studentsForPicker(req.tenant), meta: { requestId: req.id } }); } catch (e) { next(e); }
});

// Sudo-login as a student — super_admin only (mirrors the staff sudo carve-out).
router.post('/students/:id/sudo-login',
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN),
  validate({ params: z.object({ id: z.string().uuid() }) }),
  async (req, res, next) => {
    try { res.json({ data: await studentAuth.sudoLoginAsStudent(req.tenant, req.params.id), meta: { requestId: req.id } }); } catch (e) { next(e); }
  });

export default router;
