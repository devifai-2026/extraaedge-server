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
  createReceiptSchema, createCenterSchema, updateCenterSchema,
} from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Admissions module is accessible to account_manager + super_admin.
// Counsellors and sales_managers don't see this module in the sidebar
// and the server enforces the same restriction here.
const acctRole = requireRole(
  SYSTEM_TENANT_ROLES.ACCOUNT_MANAGER,
  SYSTEM_TENANT_ROLES.SUPER_ADMIN,
);
router.use(acctRole);

// Dashboard summary + charts
router.get('/dashboard', controller.dashboard);

// Pending admissions queue (converted leads w/o admission + pending_approval admissions)
router.get('/pending-admissions', controller.pendingAdmissions);
router.get('/pending-admissions/count', controller.pendingAdmissionsCount);

// Reports (must come BEFORE /:id catch)
router.get('/reports/pay-schedule', validate({ query: reportQuery }), controller.paySchedule);
router.get('/reports/collection-receipt-wise', validate({ query: reportQuery }), controller.collectionReceiptWise);

// Receipts (flat list across admissions)
router.get('/receipts', validate({ query: reportQuery }), controller.listReceipts);
router.delete('/receipts/:id', validate({ params: idParam }), controller.deleteReceipt);

// Centers — super_admin manages, account_manager reads.
router.get('/centers', controller.listCenters);
router.post('/centers', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ body: createCenterSchema }), controller.createCenter);
router.put('/centers/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam, body: updateCenterSchema }), controller.updateCenter);
router.delete('/centers/:id', requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN), validate({ params: idParam }), controller.deleteCenter);

// Admissions CRUD
router.get('/', validate({ query: listQuery }), controller.list);
router.get('/:id', validate({ params: idParam }), controller.get);
router.post('/', validate({ body: createAdmissionSchema }), controller.create);
router.put('/:id', validate({ params: idParam, body: updateAdmissionSchema }), controller.update);
router.delete('/:id', validate({ params: idParam }), controller.remove);

// Status transitions
router.post('/:id/approve', validate({ params: idParam }), controller.approve);
router.post('/:id/break', validate({ params: idParam, body: z.object({ reason: z.string().optional() }).optional() }), controller.markBreak);
router.post('/:id/resume', validate({ params: idParam }), controller.resume);
router.post('/:id/complete', validate({ params: idParam }), controller.complete);

// Per-admission receipts
router.post('/:id/receipts', validate({ params: idParam, body: createReceiptSchema }), controller.createReceipt);

export default router;
