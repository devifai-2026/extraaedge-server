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
const programParam = z.object({ programId: uuid });

// ---- Student self-view (student principal). Must come BEFORE the staff chain. ----
router.get('/my-course', studentAuthRequired, tenantRequired, controller.myCourse);
router.get('/my-dashboard', studentAuthRequired, tenantRequired, controller.dashboard);

// ---- Staff (trainers/head/admin) ----
router.use(authRequired, tenantRequired);
const staff = requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  LMS_TENANT_ROLES.HEAD_TRAINER,
  LMS_TENANT_ROLES.TRAINER,
);
router.use(staff);

// Courses
router.get('/', controller.listCourses);
// Teaching-staff pool for the "add trainer" picker (head trainers can't list
// all users; this returns just head_trainer/trainer users). MUST be before the
// /:programId route so it isn't captured as a programId.
router.get('/assignable-staff', controller.assignableStaff);
// Trainer dashboard insights (totals + student roster across the actor's courses).
router.get('/insights', controller.trainerInsights);
// Branches the actor can switch between (multi-branch trainers).
router.get('/my-branches', controller.myBranches);
// Trainer leave (Phase G9c). Placed before /:programId so they aren't captured.
router.get('/leaves/mine', controller.myLeaves);
router.post('/leaves', validate({ body: z.object({ trainer_id: uuid.optional(), from_date: z.string(), to_date: z.string(), reason: z.string().max(1000).optional().nullable() }) }), controller.markLeave);
router.delete('/leaves/:id', validate({ params: z.object({ id: uuid }) }), controller.cancelLeave);
router.get('/leaves', controller.programLeaves); // ?programId= (head/admin roster view)
// Students management (admin + head trainer, course-scoped): list, reset pw, sudo.
router.get('/students', controller.listCourseStudents);
router.post('/students/:studentId/reset-password', validate({ params: z.object({ studentId: uuid }) }), controller.resetStudentPassword);
router.post('/students/:studentId/sudo-login', validate({ params: z.object({ studentId: uuid }) }), controller.sudoStudent);
router.get('/:programId', validate({ params: programParam }), controller.getCourse);

// Modules
router.get('/:programId/modules', validate({ params: programParam }), controller.listModules);
router.post('/:programId/modules', validate({ params: programParam, body: z.object({
  name: z.string().min(1).max(160), description: z.string().max(2000).optional(),
  order_index: z.number().int().optional(), syllabus: z.array(z.any()).optional(),
}) }), controller.createModule);
router.put('/:programId/modules/:moduleId', validate({ params: z.object({ programId: uuid, moduleId: uuid }), body: z.object({
  name: z.string().min(1).max(160).optional(), description: z.string().max(2000).optional(),
  order_index: z.number().int().optional(), syllabus: z.array(z.any()).optional(),
}) }), controller.updateModule);
router.delete('/:programId/modules/:moduleId', validate({ params: z.object({ programId: uuid, moduleId: uuid }) }), controller.deleteModule);

// Attendance history (per-student summary across the course's classes)
router.get('/:programId/attendance-history', validate({ params: programParam }), controller.attendanceHistory);

// Trainers
router.get('/:programId/trainers', validate({ params: programParam }), controller.listTrainers);
router.post('/:programId/trainers', validate({ params: programParam, body: z.object({
  user_id: uuid, role: z.enum(['head', 'trainer']).optional(), module_id: uuid.nullable().optional(),
}) }), controller.addTrainer);
router.delete('/:programId/trainers/:id', validate({ params: z.object({ programId: uuid, id: uuid }) }), controller.removeTrainer);
// Head/admin creates a NEW teaching user and binds them to this course.
router.post('/:programId/create-trainer', validate({ params: programParam, body: z.object({
  name: z.string().min(1).max(160), email: z.string().email(), password: z.string().min(10),
  role: z.enum(['head', 'trainer']).default('trainer'), module_id: uuid.nullable().optional(),
}) }), controller.createTrainer);

// Batches
router.get('/:programId/batches', validate({ params: programParam }), controller.listBatches);
router.post('/:programId/batches', validate({ params: programParam, body: z.object({
  name: z.string().min(1).max(120), start_date: z.string().optional().nullable(), end_date: z.string().optional().nullable(),
}) }), controller.createBatch);
router.get('/:programId/batches/:batchId/students', validate({ params: z.object({ programId: uuid, batchId: uuid }) }), controller.listBatchStudents);
router.get('/:programId/unassigned-students', validate({ params: programParam }), controller.listUnassignedStudents);
router.post('/:programId/batches/place', validate({ params: programParam, body: z.object({
  batch_id: uuid, student_id: uuid.optional(), student_ids: z.array(uuid).optional(), share_recordings: z.boolean().optional(),
}) }), controller.placeStudent);
router.post('/:programId/batches/:batchId/complete', validate({ params: z.object({ programId: uuid, batchId: uuid }) }), controller.completeBatch);
router.post('/:programId/batches/merge', validate({ params: programParam, body: z.object({
  source_batch_id: uuid, target_batch_id: uuid, share_recordings: z.boolean().optional(),
}) }), controller.mergeBatches);

export default router;
