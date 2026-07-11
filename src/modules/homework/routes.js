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
s.get('/student', controller.studentAssignments);
s.post('/student/:id/submit', validate({ params: idParam, body: z.object({
  file_r2_key: z.string().optional().nullable(), notes: z.string().max(4000).optional().nullable(),
}) }), controller.submit);
router.use(s);

// ---- Trainer / head / admin / branch_manager ----
router.use(authRequired, tenantRequired, requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  LMS_TENANT_ROLES.HEAD_TRAINER, LMS_TENANT_ROLES.TRAINER,
));
router.get('/', controller.list); // ?programId=
router.post('/', validate({ body: z.object({
  program_id: uuid, module_id: uuid.optional().nullable(), title: z.string().min(1).max(200),
  brief: z.string().max(4000).optional().nullable(), max_marks: z.number().min(1).max(1000).optional(), deadline: z.string().optional().nullable(),
}) }), controller.create);
router.delete('/:id', validate({ params: idParam }), controller.remove);
router.get('/:id/submissions', validate({ params: idParam }), controller.listSubmissions);
router.post('/:id/grade', validate({ params: idParam, body: z.object({ submission_id: uuid, marks: z.number().min(0).max(1000), feedback: z.string().max(4000).optional() }) }), controller.grade);

export default router;
