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
const questionBody = z.object({
  question: z.string().min(1).max(500),
  options: z.array(z.string().max(200)).min(2).max(6),
  correct_index: z.number().int().min(0).optional().nullable(),
  source: z.enum(['bank', 'adhoc']).optional(),
  visible_minutes: z.number().int().min(1).max(120).optional(),
});

// ---- Student routes (student principal) — BEFORE the staff chain. ----
const s = express.Router();
s.use(studentAuthRequired, tenantRequired);
s.get('/my/classes', controller.studentClasses);
s.get('/:id/open-questions', validate({ params: idParam }), controller.openQuestions);
s.post('/:id/answer', validate({ params: idParam, body: z.object({ question_id: uuid, option_index: z.number().int().min(0) }) }), controller.answer);
s.post('/:id/pre-notify-absence', validate({ params: idParam }), controller.preNotifyAbsence);
s.post('/:id/join-mode', validate({ params: idParam, body: z.object({ join_mode: z.enum(['online', 'offline']) }) }), controller.setJoinMode);
router.use('/student', s);

// ---- Staff (trainers/head/admin) ----
router.use(authRequired, tenantRequired, requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  LMS_TENANT_ROLES.HEAD_TRAINER, LMS_TENANT_ROLES.TRAINER,
));

router.get('/', controller.listClasses);
router.post('/', validate({ body: z.object({
  program_id: uuid, module_id: uuid.nullable().optional(), batch_id: uuid,
  title: z.string().min(1).max(200), kind: z.enum(['lecture', 'mock_test']).optional(),
  mode: z.enum(['online', 'offline']).optional(), meeting_url: z.string().max(1000).optional().nullable(),
  starts_at: z.string(), ends_at: z.string(),
}) }), controller.createClass);
router.put('/:id', validate({ params: idParam }), controller.updateClass);
router.delete('/:id', validate({ params: idParam }), controller.deleteClass);
router.post('/:id/lifecycle', validate({ params: idParam, body: z.object({ action: z.enum(['class_started', 'class_ended', 'mock_test']) }) }), controller.markLifecycle);

// Question bank (per module; programId via query for scope)
router.get('/bank/:moduleId', validate({ params: z.object({ moduleId: uuid }) }), controller.listBank);
router.post('/bank/:moduleId', validate({ params: z.object({ moduleId: uuid }), body: questionBody }), controller.addBankQuestion);
router.delete('/bank-question/:id', validate({ params: idParam }), controller.deleteBankQuestion);

// Fire question + attendance
router.post('/:id/fire-question', validate({ params: idParam, body: questionBody }), controller.fireQuestion);
router.get('/:id/questions', validate({ params: idParam }), controller.listQuestions);
router.get('/:id/attendance', validate({ params: idParam }), controller.attendanceTable);
router.post('/:id/attendance/edit', validate({ params: idParam, body: z.object({ student_id: uuid, status: z.enum(['present', 'absent']) }) }), controller.editAttendance);

export default router;
