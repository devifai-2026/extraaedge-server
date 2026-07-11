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
s.get('/student/feed', controller.studentFeed);
s.post('/student/openings/:id/apply', validate({ params: idParam }), controller.applyToOpening);
router.use(s);

// ---- Placement team / admin / branch_manager ----
router.use(authRequired, tenantRequired, requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, LMS_TENANT_ROLES.PLACEMENT,
));

const criteriaSchema = z.object({
  min_attendance_pct: z.number().min(0).max(100).optional(),
  project_submitted: z.boolean().optional(),
  capstone_submitted: z.boolean().optional(),
  module_completed_id: uuid.optional(),
  course_completed: z.boolean().optional(),
}).optional();

router.get('/counts', controller.counts);

// Companies
router.get('/companies', controller.listCompanies);
router.post('/companies', validate({ body: z.object({
  name: z.string().min(1).max(200), website: z.string().max(500).optional().nullable(), industry: z.string().max(200).optional().nullable(),
  location: z.string().max(200).optional().nullable(), about: z.string().max(4000).optional().nullable(), logo_r2_key: z.string().optional().nullable(),
}) }), controller.createCompany);
router.post('/companies/bulk', validate({ body: z.object({ rows: z.array(z.object({
  name: z.string().min(1), website: z.string().optional().nullable(), industry: z.string().optional().nullable(), location: z.string().optional().nullable(), about: z.string().optional().nullable(),
})).max(1000) }) }), controller.bulkCreateCompanies);
router.put('/companies/:id', validate({ params: idParam }), controller.updateCompany);
router.delete('/companies/:id', validate({ params: idParam }), controller.deleteCompany);

// Openings
router.get('/openings', controller.listOpenings); // ?status=open|closed
router.post('/openings', validate({ body: z.object({
  company_id: uuid, title: z.string().min(1).max(200), description: z.string().max(8000).optional().nullable(),
  ctc: z.string().max(120).optional().nullable(), location: z.string().max(200).optional().nullable(), job_type: z.string().max(60).optional().nullable(),
  criteria: criteriaSchema, poster_r2_key: z.string().optional().nullable(), program_id: uuid.optional().nullable(),
}) }), controller.createOpening);
router.get('/openings/:id/preview-audience', validate({ params: idParam }), controller.previewAudience);
router.post('/openings/:id/fire', validate({ params: idParam, body: z.object({ branch_id: uuid.optional().nullable() }).optional() }), controller.fire);
router.post('/openings/:id/status', validate({ params: idParam, body: z.object({ status: z.enum(['open', 'closed']) }) }), controller.setOpeningStatus);
router.delete('/openings/:id', validate({ params: idParam }), controller.deleteOpening);

// Applications
router.get('/openings/:id/applications', validate({ params: idParam }), controller.listApplications);
router.post('/applications/:id/status', validate({ params: idParam, body: z.object({ status: z.enum(['fired', 'applied', 'shortlisted', 'selected', 'rejected']), note: z.string().max(2000).optional() }) }), controller.setApplicationStatus);

export default router;
