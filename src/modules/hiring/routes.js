// Speedup Hiring — internal staff recruitment.
//
// Gated to the HR recruitment tiers and super_admin. Candidate records carry
// salary expectations, phone numbers and interview feedback for people who do
// NOT work here, so this is not general staff information — no manager tier,
// no branch manager.
import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';

const router = express.Router();
router.use(
  authRequired,
  tenantRequired,
  requireRole(
    SYSTEM_TENANT_ROLES.SUPER_ADMIN,
    LMS_TENANT_ROLES.HR_RECRUITER,
    LMS_TENANT_ROLES.HR_TEAM_LEAD,
  ),
);

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

// ---------- dashboard ----------
router.get('/dashboard', controller.dashboard);

// ---------- statuses (Configuration) ----------
const statusBody = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(['open', 'hired', 'rejected']).optional(),
  applies_to: z.enum(['candidate', 'interview', 'both']).optional(),
  order_index: z.number().int().optional(),
});
router.get('/statuses', controller.listStatuses);
router.post('/statuses', validate({ body: statusBody }), controller.createStatus);
router.put('/statuses/:id', validate({
  params: idParam,
  body: statusBody.partial().extend({ is_active: z.boolean().optional() }),
}), controller.updateStatus);

// ---------- positions ----------
const positionBody = z.object({
  title: z.string().min(1).max(200),
  department: z.string().max(120).optional().nullable(),
  branch_id: uuid.optional().nullable(),
  openings_count: z.number().int().min(1).max(999).optional(),
  status: z.enum(['open', 'on_hold', 'closed']).optional(),
});
router.get('/positions', controller.listPositions);
router.post('/positions', validate({ body: positionBody }), controller.createPosition);
router.put('/positions/:id', validate({ params: idParam, body: positionBody.partial() }), controller.updatePosition);
router.delete('/positions/:id', validate({ params: idParam }), controller.deletePosition);

// ---------- postings (where a vacancy was advertised) ----------
router.get('/positions/:id/postings', validate({ params: idParam }), controller.listPostings);
router.post('/positions/:id/postings', validate({
  params: idParam,
  body: z.object({
    channel: z.string().min(1).max(40),
    external_url: z.string().max(1000).optional().nullable(),
    notes: z.string().max(2000).optional().nullable(),
  }),
}), controller.createPosting);
router.delete('/postings/:id', validate({ params: idParam }), controller.deletePosting);

// ---------- bulk import ----------
// Declared BEFORE /candidates/:id so "import" is not swallowed as an id.
const importBody = z.object({
  rows: z.array(z.record(z.any())).min(1).max(5000),
  position_id: uuid.optional(),
});
router.post('/candidates/import/preview', validate({ body: importBody }), controller.previewCandidateImport);
router.post('/candidates/import/commit', validate({ body: importBody }), controller.commitCandidateImport);
router.post('/interviews/import/preview', validate({ body: importBody }), controller.previewInterviewImport);
router.post('/interviews/import/commit', validate({ body: importBody }), controller.commitInterviewImport);

// ---------- candidates ----------
const candidateBody = z.object({
  position_id: uuid.optional().nullable(),
  contacted_on: z.string().optional().nullable(),
  name: z.string().min(1).max(200),
  phone: z.string().max(40).optional().nullable(),
  email: z.string().max(200).optional().nullable(),
  location: z.string().max(200).optional().nullable(),
  highest_qualification: z.string().max(120).optional().nullable(),
  stream: z.string().max(120).optional().nullable(),
  experience_level: z.enum(['fresher', 'experienced']).optional().nullable(),
  current_area: z.string().max(200).optional().nullable(),
  current_salary: z.number().optional().nullable(),
  expected_salary: z.number().optional().nullable(),
  notice_period: z.string().max(120).optional().nullable(),
  status_id: uuid.optional().nullable(),
  remark: z.string().max(4000).optional().nullable(),
  remark_2: z.string().max(4000).optional().nullable(),
  posting_id: uuid.optional().nullable(),
  owner_id: uuid.optional().nullable(),
});
router.get('/candidates', controller.listCandidates);
router.post('/candidates', validate({ body: candidateBody }), controller.createCandidate);
router.get('/candidates/:id', validate({ params: idParam }), controller.getCandidate);
router.put('/candidates/:id', validate({ params: idParam, body: candidateBody.partial() }), controller.updateCandidate);
router.delete('/candidates/:id', validate({ params: idParam }), controller.deleteCandidate);
router.post('/candidates/:id/status', validate({
  params: idParam,
  body: z.object({ status_id: uuid.nullable(), note: z.string().max(2000).optional() }),
}), controller.setCandidateStatus);

// ---------- interviews ----------
const interviewBody = z.object({
  candidate_id: uuid,
  scheduled_at: z.string().optional().nullable(),
  mode: z.enum(['online', 'in_person', 'telephonic']).optional().nullable(),
  status_id: uuid.optional().nullable(),
  interviewer_id: uuid.optional().nullable(),
  remark_1: z.string().max(4000).optional().nullable(),
  remark_2: z.string().max(4000).optional().nullable(),
});
router.get('/interviews', controller.listInterviews);
router.post('/interviews', validate({ body: interviewBody }), controller.createInterview);
router.put('/interviews/:id', validate({
  params: idParam, body: interviewBody.partial().omit({ candidate_id: true }),
}), controller.updateInterview);
router.delete('/interviews/:id', validate({ params: idParam }), controller.deleteInterview);

export default router;
