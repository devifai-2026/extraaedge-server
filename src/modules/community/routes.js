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
const commentBody = z.object({ body: z.string().min(1).max(2000) });

// ---- Student routes (student principal) — BEFORE the staff chain. ----
const s = express.Router();
s.use(studentAuthRequired, tenantRequired);
s.get('/student/recordings', controller.studentRecordings);
s.get('/student/recordings/:id/url', validate({ params: idParam }), controller.studentRecordingUrl);
s.get('/student/announcements', controller.studentAnnouncements);
s.get('/student/announcements/:id/comments', validate({ params: idParam }), controller.studentComments);
s.post('/student/announcements/:id/comments', validate({ params: idParam, body: commentBody }), controller.studentComment);
s.post('/student/announcements/:id/like', validate({ params: idParam }), controller.studentLike);
router.use(s);

// ---- Staff (trainers/head/admin) ----
router.use(authRequired, tenantRequired, requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  LMS_TENANT_ROLES.HEAD_TRAINER, LMS_TENANT_ROLES.TRAINER,
));

// Recordings
router.get('/recordings/missed', controller.missedRecordings);
router.get('/classes/:classId/recordings', validate({ params: z.object({ classId: uuid }) }), controller.listRecordings);
router.post('/classes/:classId/recordings', validate({ params: z.object({ classId: uuid }), body: z.object({
  r2_key: z.string().min(1), label: z.string().max(200).optional(),
}) }), controller.addRecording);
router.get('/recordings/:id/url', validate({ params: idParam }), controller.trainerRecordingUrl);

// Announcements
router.get('/announcements', controller.listAnnouncements);   // ?programId=
router.post('/announcements', validate({ body: z.object({
  program_id: uuid, batch_id: uuid.nullable().optional(), title: z.string().max(200).optional(), body: z.string().min(1).max(4000),
}) }), controller.postAnnouncement);
router.get('/announcements/:id/comments', validate({ params: idParam }), controller.listComments);
router.post('/announcements/:id/comments', validate({ params: idParam, body: commentBody }), controller.commentAsTrainer);
router.post('/announcements/:id/like', validate({ params: idParam }), controller.likeAsTrainer);

export default router;
