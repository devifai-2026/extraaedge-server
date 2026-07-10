import express from 'express';
import { z } from 'zod';
import { authRequired, studentAuthRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';

const router = express.Router();
const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

// ---- Student ----
const s = express.Router();
s.use(studentAuthRequired, tenantRequired);
s.get('/student/slots', controller.studentSlots);
router.use(s);

// ---- Trainer/head/admin ----
router.use(authRequired, tenantRequired, requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  LMS_TENANT_ROLES.HEAD_TRAINER, LMS_TENANT_ROLES.TRAINER,
));
router.get('/', controller.list);                       // ?programId=
router.get('/students', controller.programStudents);    // ?programId=
router.post('/', validate({ body: z.object({
  program_id: uuid, title: z.string().min(1).max(200), meeting_url: z.string().max(1000).optional().nullable(), max_marks: z.number().min(1).max(1000).optional(),
}) }), controller.create);
router.get('/:id/slots', validate({ params: idParam }), controller.listSlots);
router.post('/:id/slots', validate({ params: idParam, body: z.object({ student_id: uuid, slot_at: z.string().optional().nullable() }) }), controller.assignSlot);
router.post('/slots/:slotId/grade', validate({ params: z.object({ slotId: uuid }), body: z.object({ marks: z.number().min(0).max(1000), feedback: z.string().max(4000).optional() }) }), controller.gradeSlot);

export default router;
