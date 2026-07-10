import express from 'express';
import { z } from 'zod';
import { tenantRequired } from '../../middleware/tenant.js';
import { studentAuthRequired } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';

const router = express.Router();

// Unauthenticated routes: the tenant is resolved from the x-tenant-slug header
// (dev) or subdomain (prod). The student FE always sends x-tenant-slug.
router.post('/login', tenantRequired, validate({ body: z.object({
  email: z.string().email(),
  password: z.string().min(1),
}) }), controller.login);

router.post('/set-password', tenantRequired, validate({ body: z.object({
  token: z.string().min(10),
  password: z.string().min(8),
}) }), controller.setPassword);

router.post('/request-reset', tenantRequired, validate({ body: z.object({
  email: z.string().email(),
}) }), controller.requestReset);

// Authenticated: student-auth FIRST (sets req.student.tenantSlug), then
// tenantRequired resolves the tenant from that.
router.get('/me', studentAuthRequired, tenantRequired, controller.me);

export default router;
