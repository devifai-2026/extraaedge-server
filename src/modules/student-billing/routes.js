import express from 'express';
import { z } from 'zod';
import { studentAuthRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

const router = express.Router();
const idParam = z.object({ id: z.string().uuid() });

// Student principal first (sets req.student.tenantSlug), then resolve the tenant.
router.use(studentAuthRequired, tenantRequired);

// A student's own fee schedule, next EMI due, totals + receipts.
router.get('/payments', controller.myPayments);
// The public share token for one of the student's OWN receipts (for download).
router.get('/receipts/:id/token', validate({ params: idParam }), controller.myReceiptToken);

export default router;
