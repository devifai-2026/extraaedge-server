import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import {
  createAdmissionSchema, updateAdmissionSchema, listQuery, reportQuery, idParam,
  createReceiptSchema, createCenterSchema, updateCenterSchema, paymentDetailsQuery,
} from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Accounts-owned actions (approve/reject/drop/dashboard/reports/receipts/…):
// account_manager + super_admin only.
const acctRole = requireRole(
  SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER,
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
);
// Counsellor-facing subset (their own converted students): counsellors may
// VIEW their admissions and configure+send the admission link, but not run the
// accounts workflow. The rows are scoped to the actor server-side (see
// admissions/service.list + guided_by_counsellor_id) so a counsellor only ever
// sees admissions for leads they own/converted.
const acctOrCounsellor = requireRole(
  SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER,
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
  SYSTEM_TENANT_ROLES.COUNSELLOR,
);
// NOTE: gating is now PER-ROUTE (no blanket router.use) so counsellors can
// reach only the scoped subset below.

// Dashboard summary + charts
router.get('/dashboard', acctRole, controller.dashboard);

// Pending admissions queue (converted leads w/o admission + pending_approval admissions)
router.get('/pending-admissions', acctRole, controller.pendingAdmissions);
router.get('/pending-admissions/count', acctRole, controller.pendingAdmissionsCount);
router.get('/emi-digest', acctRole, controller.emiDigest);

// Tenant-wide admission pipeline snapshot (for the new admin sidebar page
// + a section on the main analytics dashboard). Must come BEFORE /:id.
router.get('/lead-status-snapshot', acctRole, controller.leadStatusSnapshot);

// Counsellor "My Students" — their converted leads + submitted admissions.
// Scoped to the acting user server-side. Must come BEFORE /:id.
router.get('/my-students', acctOrCounsellor, controller.myStudents);

// Per-lead timeline lookup for the lead drawer's Admission Timeline tab.
// The drawer only has lead.id; this hop resolves the admission internally.
// Counsellors can view the timeline of THEIR own converted lead's admission.
router.get(
  '/by-lead/:leadId/timeline',
  acctOrCounsellor,
  validate({ params: z.object({ leadId: z.string().uuid() }) }),
  controller.timelineByLead,
);

// Share-link generator for the public student-facing admission form.
// Body optionally carries `payment_account_id` — the account the accounts
// user picked for the student to pay into. Each call mints a new 24h
// token (regenerate = call again). Counsellors may send the link for their
// own converted leads.
router.post(
  '/share-link/:leadId',
  acctOrCounsellor,
  validate({
    params: z.object({ leadId: z.string().uuid() }),
    body: z.object({ payment_account_id: z.string().uuid().optional().nullable() }).optional(),
  }),
  controller.generateShareLink,
);

// Reports (must come BEFORE /:id catch)
router.get('/reports/pay-schedule', acctRole, validate({ query: reportQuery }), controller.paySchedule);
router.get('/reports/collection-receipt-wise', acctRole, validate({ query: reportQuery }), controller.collectionReceiptWise);

// Receipts (flat list across admissions)
router.get('/receipts', acctRole, validate({ query: reportQuery }), controller.listReceipts);
// Admin Payment Details ledger — paginated/filterable/sortable/searchable.
router.get('/payment-details', acctRole, validate({ query: paymentDetailsQuery }), controller.listPaymentDetails);
// Payment analytics for the admin dashboard charts.
router.get('/payment-analytics', acctRole, controller.paymentAnalytics);
router.delete('/receipts/:id', acctRole, validate({ params: idParam }), controller.deleteReceipt);

// Centers — super_admin manages, account_manager reads.
router.get('/centers', acctRole, controller.listCenters);
router.post('/centers', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ body: createCenterSchema }), controller.createCenter);
router.put('/centers/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam, body: updateCenterSchema }), controller.updateCenter);
router.delete('/centers/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER), validate({ params: idParam }), controller.deleteCenter);

// Admissions CRUD. List + get are counsellor-accessible but SCOPED in the
// service to the actor's own converted students (guided_by_counsellor_id).
router.get('/', acctOrCounsellor, validate({ query: listQuery }), controller.list);
router.get('/:id', acctOrCounsellor, validate({ params: idParam }), controller.get);

// Append-only event log for one admission. Counsellors may view their own.
router.get('/:id/timeline', acctOrCounsellor, validate({ params: idParam }), controller.timeline);
router.post('/', acctRole, validate({ body: createAdmissionSchema }), controller.create);
router.put('/:id', acctRole, validate({ params: idParam, body: updateAdmissionSchema }), controller.update);
router.delete('/:id', acctRole, validate({ params: idParam }), controller.remove);

// Status transitions — accounts workflow only (counsellors can't approve etc.).
router.post('/:id/approve', acctRole, validate({ params: idParam }), controller.approve);
router.post('/:id/reject', acctRole, validate({ params: idParam, body: z.object({ reason: z.string().optional() }).optional() }), controller.reject);
router.post('/:id/break', acctRole, validate({ params: idParam, body: z.object({ reason: z.string().optional() }).optional() }), controller.markBreak);
router.post('/:id/resume', acctRole, validate({ params: idParam }), controller.resume);
router.post('/:id/complete', acctRole, validate({ params: idParam }), controller.complete);
router.post('/:id/drop', acctRole, validate({ params: idParam, body: z.object({ reason: z.string().optional() }).optional() }), controller.drop);

// Per-admission receipts
router.post('/:id/receipts', acctRole, validate({ params: idParam, body: createReceiptSchema }), controller.createReceipt);

export default router;
