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
const replyBody = z.object({ body: z.string().min(1).max(4000) });

// ---- Student routes (student principal) ----
const s = express.Router();
s.use(studentAuthRequired, tenantRequired);
s.get('/student/trainers', controller.trainers);
s.get('/student/threads', controller.myThreads);
s.post('/student/threads', validate({ body: z.object({
  title: z.string().min(1).max(200), body: z.string().min(1).max(4000), mentions: z.array(uuid).max(20).optional(),
}) }), controller.createThread);
s.get('/student/threads/:id/replies', validate({ params: idParam }), controller.studentReplies);
s.post('/student/threads/:id/replies', validate({ params: idParam, body: replyBody }), controller.studentReply);
router.use(s);

// ---- Trainer/head/admin ----
router.use(authRequired, tenantRequired, requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  LMS_TENANT_ROLES.HEAD_TRAINER, LMS_TENANT_ROLES.TRAINER,
));
router.get('/threads', controller.listThreads);   // ?programId=
router.get('/threads/:id/replies', validate({ params: idParam }), controller.trainerReplies);
router.post('/threads/:id/replies', validate({ params: idParam, body: replyBody }), controller.trainerReply);

export default router;
