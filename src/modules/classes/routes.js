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
// options are only required for 'mcq' — true_false has them seeded server-side
// and long_text has none, so the array is optional here and the service's
// normaliseQuestionInput enforces the per-type rules.
const questionBody = z.object({
  question: z.string().min(1).max(500),
  question_type: z.enum(['mcq', 'true_false', 'long_text']).optional(),
  options: z.array(z.string().max(200)).max(6).optional(),
  correct_index: z.number().int().min(0).optional().nullable(),
  source: z.enum(['bank', 'adhoc']).optional(),
  visible_minutes: z.number().int().min(1).max(120).optional(),
});

// A student sends EITHER option_index (choice kinds) or answer_text
// (long_text); the service rejects the wrong one for the question's type.
const answerBody = z.object({
  question_id: uuid,
  option_index: z.number().int().min(0).optional(),
  answer_text: z.string().max(5000).optional(),
});

// ---- Student routes (student principal) — BEFORE the staff chain. ----
const s = express.Router();
s.use(studentAuthRequired, tenantRequired);
s.get('/my/classes', controller.studentClasses);
s.get('/:id/open-questions', validate({ params: idParam }), controller.openQuestions);
s.post('/:id/answer', validate({ params: idParam, body: answerBody }), controller.answer);
s.post('/:id/pre-notify-absence', validate({ params: idParam, body: z.object({ reason: z.string().max(500).optional() }).optional() }), controller.preNotifyAbsence);
s.post('/:id/join-mode', validate({ params: idParam, body: z.object({ join_mode: z.enum(['online', 'offline']), reason: z.string().max(500).optional() }) }), controller.setJoinMode);
router.use('/student', s);

// ---- Staff (trainers/head/admin) ----
router.use(authRequired, tenantRequired, requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  LMS_TENANT_ROLES.HEAD_TRAINER, LMS_TENANT_ROLES.TRAINER,
));

router.get('/', controller.listClasses);
// Literal path, declared before any ':id' route so it is not matched as an id.
router.get('/pending-completions', controller.pendingCompletions);
router.post('/', validate({ body: z.object({
  program_id: uuid, module_id: uuid.nullable().optional(), batch_id: uuid, trainer_id: uuid.nullable().optional(),
  title: z.string().min(1).max(200), kind: z.enum(['lecture', 'mock_test', 'demo']).optional(),
  mode: z.enum(['online', 'offline']).optional(), meeting_url: z.string().max(1000).optional().nullable(),
  starts_at: z.string(), ends_at: z.string(),
}) }), controller.createClass);
router.put('/:id', validate({ params: idParam, body: z.object({
  title: z.string().min(1).max(200).optional(), module_id: uuid.nullable().optional(), trainer_id: uuid.nullable().optional(),
  mode: z.enum(['online', 'offline']).optional(), meeting_url: z.string().max(1000).optional().nullable(),
  starts_at: z.string().optional(), ends_at: z.string().optional(),
}).optional() }), controller.updateClass);
router.delete('/:id', validate({ params: idParam }), controller.deleteClass);
router.post('/:id/lifecycle', validate({ params: idParam, body: z.object({ action: z.enum(['class_started', 'class_ended', 'mock_test']) }) }), controller.markLifecycle);
// Explicit completion. `not_conducted` is a real answer a trainer can give,
// rather than staying silent and letting the 24-hour sweep decide. is_billable
// is manager-only — see service.setCompletion.
router.post('/:id/completion', validate({
  params: idParam,
  body: z.object({
    status: z.enum(['completed', 'not_conducted']),
    note: z.string().max(500).optional(),
    is_billable: z.boolean().optional(),
  }),
}), controller.setCompletion);

// Question bank (per module; programId via query for scope)
router.get('/bank/:moduleId', validate({ params: z.object({ moduleId: uuid }) }), controller.listBank);
router.post('/bank/:moduleId', validate({ params: z.object({ moduleId: uuid }), body: questionBody }), controller.addBankQuestion);
router.delete('/bank-question/:id', validate({ params: idParam }), controller.deleteBankQuestion);

// Fire question + attendance
router.post('/:id/fire-question', validate({ params: idParam, body: questionBody }), controller.fireQuestion);
router.get('/:id/questions', validate({ params: idParam }), controller.listQuestions);
// Per-question results: who answered what, and who was right, by name.
router.get('/:id/question-analytics', validate({ params: idParam }), controller.questionAnalytics);
// Trainer grades one long_text answer (choice kinds are auto-graded).
router.post('/:id/grade-answer', validate({
  params: idParam,
  body: z.object({ answer_id: uuid, is_correct: z.boolean() }),
}), controller.gradeAnswer);
router.get('/:id/attendance', validate({ params: idParam }), controller.attendanceTable);
router.post('/:id/attendance/edit', validate({ params: idParam, body: z.object({ student_id: uuid, status: z.enum(['present', 'absent']) }) }), controller.editAttendance);

export default router;
