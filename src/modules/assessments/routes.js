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

// ---- Student routes ----
const s = express.Router();
s.use(studentAuthRequired, tenantRequired);
s.get('/student/tests', controller.studentTests);
s.get('/student/tests/:id', validate({ params: idParam }), controller.takeTest);
s.post('/student/tests/:id/submit', validate({ params: idParam, body: z.object({ answers: z.array(z.number().int().nullable()).max(200) }) }), controller.submitTest);
s.get('/student/projects', controller.studentProjects);
s.post('/student/projects/:id/submit', validate({ params: idParam, body: z.object({
  live_url: z.string().max(1000).optional().nullable(), github_url: z.string().max(1000).optional().nullable(), notes: z.string().max(2000).optional().nullable(),
}) }), controller.submitProject);
s.get('/student/leaderboard', controller.studentLeaderboard);
router.use(s);

// ---- Trainer/head/admin ----
router.use(authRequired, tenantRequired, requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  LMS_TENANT_ROLES.HEAD_TRAINER, LMS_TENANT_ROLES.TRAINER,
));

const questionsSchema = z.array(z.object({
  q: z.string().min(1).max(500), options: z.array(z.string().max(300)).min(2).max(6),
  correct_index: z.number().int().min(0), marks: z.number().min(0).max(1000),
})).min(1).max(100);

// Tests
router.get('/tests', controller.listTests);   // ?programId=
router.post('/tests', validate({ body: z.object({
  program_id: uuid, module_id: uuid.nullable().optional(), title: z.string().min(1).max(200), questions: questionsSchema,
}) }), controller.createTest);
router.get('/tests/:id/results', validate({ params: idParam }), controller.testResults);
// Edit (title/module always; questions only before any attempt — enforced in
// the service), publish/unpublish, and delete — so a trainer can fix a bad
// correct_index or retract a test instead of it being permanently live.
router.patch('/tests/:id', validate({ params: idParam, body: z.object({
  title: z.string().min(1).max(200).optional(), module_id: uuid.nullable().optional(), questions: questionsSchema.optional(),
}) }), controller.updateTest);
router.post('/tests/:id/publish', validate({ params: idParam, body: z.object({ published: z.boolean() }) }), controller.setTestPublished);
router.delete('/tests/:id', validate({ params: idParam }), controller.deleteTest);

// Projects
router.get('/projects', controller.listProjects);
router.post('/projects', validate({ body: z.object({
  program_id: uuid, module_id: uuid.nullable().optional(), title: z.string().min(1).max(200),
  brief: z.string().max(4000).optional(), marking_scheme: z.string().max(4000).optional(),
  max_marks: z.number().min(1).max(1000).optional(), deadline: z.string().optional().nullable(),
}) }), controller.createProject);
router.get('/projects/:id/submissions', validate({ params: idParam }), controller.listSubmissions);
router.post('/projects/:id/grade', validate({ params: idParam, body: z.object({
  submission_id: uuid, marks: z.number().min(0).max(1000), feedback: z.string().max(4000).optional(),
}) }), controller.gradeSubmission);

// Leaderboard
router.get('/leaderboard', controller.trainerLeaderboard);   // ?programId=

export default router;
