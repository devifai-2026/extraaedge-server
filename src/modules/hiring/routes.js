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
const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });

// ---------- panellist surface (NOT HR-only) ----------
//
// Mounted ABOVE the requireRole gate below on purpose. Anyone in the tenant
// can be invited onto an interview panel — a sales manager, a trainer, the
// super admin — and they must be able to see the interviews they are on and
// leave their own feedback. Putting these behind the HR gate would 403 the
// very people the invite exists for.
//
// They are still safe to expose, because each one is scoped to the CALLER:
//   /interviews/mine  returns only rows the caller sits on;
//   the feedback routes check isOnPanel first and write feedback keyed to
//   req.user.id, never a user id from the body.
// None of them expose the candidate pipeline (salary, HR remarks) that the
// HR-gated routes below do.
router.use(authRequired, tenantRequired);

router.get('/interviews/mine', controller.listMyInterviews);
router.get('/interviews/:id/feedback', validate({ params: idParam }), controller.listFeedback);
router.put('/interviews/:id/feedback', validate({
  params: idParam,
  body: z.object({
    remark: z.string().max(4000).optional().nullable(),
    recommendation: z.enum(['strong_yes', 'yes', 'no', 'strong_no', 'on_hold']).optional().nullable(),
  }),
}), controller.submitFeedback);

// ---------- everything below is HR-only ----------
router.use(
  requireRole(
    SYSTEM_TENANT_ROLES.SUPER_ADMIN,
    LMS_TENANT_ROLES.HR_RECRUITER,
    LMS_TENANT_ROLES.HR_TEAM_LEAD,
  ),
);

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

// ---------- spreadsheet reading ----------
// Which tabs does this workbook have? Asked after the file is uploaded and
// before the import is queued, so a multi-tab book can offer a sheet picker.
router.post('/workbook/sheets', validate({
  body: z.object({ file_key: z.string().min(1).max(500) }),
}), controller.workbookSheets);

// ---------- async import (file already uploaded via /uploads/presign) ----------
// Queued, not inline: a real workbook is hundreds of rows, and the global JSON
// body limit is 200kb so the file itself can never travel through the API.
router.post('/imports', validate({
  body: z.object({
    kind: z.enum(['candidate', 'interview']),
    file_key: z.string().min(1).max(500),
    file_name: z.string().max(300).optional(),
    sheet_name: z.string().max(200).optional(),
    position_id: uuid.optional(),
  }),
}), controller.queueImport);
router.get('/imports', controller.listImports);
router.get('/imports/:id', validate({ params: idParam }), controller.getImport);
router.get('/imports/:id/rows', validate({ params: idParam }), controller.importRows);

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
  // Legacy single figure. Still accepted so older clients and the bulk
  // importer keep working; the service mirrors it into both ends of the range.
  expected_salary: z.number().optional().nullable(),
  // The range candidates actually quote ("20k to 25k"). Either end may be
  // null for an open-ended expectation.
  expected_salary_min: z.number().optional().nullable(),
  expected_salary_max: z.number().optional().nullable(),
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
  round_id: uuid.optional().nullable(),
  // Optional by product decision: an interview is often booked before the
  // Meet/Teams link exists, and an in-person round never needs one.
  meeting_link: z.string().max(1000).optional().nullable(),
  // Who sits on the panel. Replaces the panel wholesale (see repo.setPanel).
  panel_user_ids: z.array(uuid).optional(),
});
router.get('/rounds', controller.listRounds);
router.get('/interviews', controller.listInterviews);
router.get('/interviews/:id/panel', validate({ params: idParam }), controller.listPanel);
router.put('/interviews/:id/panel', validate({
  params: idParam, body: z.object({ user_ids: z.array(uuid) }),
}), controller.setPanel);
router.post('/interviews', validate({ body: interviewBody }), controller.createInterview);
router.put('/interviews/:id', validate({
  params: idParam, body: interviewBody.partial().omit({ candidate_id: true }),
}), controller.updateInterview);
router.delete('/interviews/:id', validate({ params: idParam }), controller.deleteInterview);

export default router;
