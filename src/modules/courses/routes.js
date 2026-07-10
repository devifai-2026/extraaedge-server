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

// Trainers
router.get('/:programId/trainers', validate({ params: programParam }), controller.listTrainers);
router.post('/:programId/trainers', validate({ params: programParam, body: z.object({
  user_id: uuid, role: z.enum(['head', 'trainer']).optional(), module_id: uuid.nullable().optional(),
}) }), controller.addTrainer);
router.delete('/:programId/trainers/:id', validate({ params: z.object({ programId: uuid, id: uuid }) }), controller.removeTrainer);

// Batches
router.get('/:programId/batches', validate({ params: programParam }), controller.listBatches);
router.post('/:programId/batches', validate({ params: programParam, body: z.object({
  name: z.string().min(1).max(120), start_date: z.string().optional().nullable(), end_date: z.string().optional().nullable(),
}) }), controller.createBatch);
router.get('/:programId/batches/:batchId/students', validate({ params: z.object({ programId: uuid, batchId: uuid }) }), controller.listBatchStudents);
router.get('/:programId/unassigned-students', validate({ params: programParam }), controller.listUnassignedStudents);
router.post('/:programId/batches/place', validate({ params: programParam, body: z.object({
  batch_id: uuid, student_id: uuid, share_recordings: z.boolean().optional(),
}) }), controller.placeStudent);
router.post('/:programId/batches/merge', validate({ params: programParam, body: z.object({
  source_batch_id: uuid, target_batch_id: uuid, share_recordings: z.boolean().optional(),
}) }), controller.mergeBatches);

export default router;
