import express from 'express';
import { z } from 'zod';
import { tenantRequired } from '../../middleware/tenant.js';
import { studentAuthRequired, authRequired } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';

const router = express.Router();

// Unauthenticated routes: the tenant is resolved from the x-tenant-slug header
// (dev) or subdomain (prod). The student FE always sends x-tenant-slug.

// Public branding for the login screen (logo/name/colors by tenant slug).
router.get('/branding', tenantRequired, controller.branding);

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

// ---- Student profile (self) ----
router.get('/profile', studentAuthRequired, tenantRequired, controller.getProfile);
router.put('/profile', studentAuthRequired, tenantRequired, validate({ body: z.object({
  phone: z.string().max(40).optional().nullable(),
  dob: z.string().optional().nullable(),
  address: z.string().max(500).optional().nullable(),
  github_url: z.string().max(300).optional().nullable(),
  linkedin_url: z.string().max(300).optional().nullable(),
  portfolio_url: z.string().max(300).optional().nullable(),
  skills: z.string().max(1000).optional().nullable(),
  bio: z.string().max(2000).optional().nullable(),
  photo_r2_key: z.string().max(500).optional().nullable(),
}) }), controller.updateProfile);
router.post('/profile/presign', studentAuthRequired, tenantRequired, validate({ body: z.object({
  kind: z.enum(['photo', 'cv']), content_type: z.string().min(1), size_bytes: z.number().int().positive(), filename: z.string().optional(),
}) }), controller.presign);
router.post('/profile/cv', studentAuthRequired, tenantRequired, validate({ body: z.object({
  r2_key: z.string().min(1), filename: z.string().max(300).optional(),
}) }), controller.setCv);

// ---- Trainer/admin view of a student's profile (staff auth). ----
router.get('/students/:studentId/profile',
  authRequired, tenantRequired,
  requireRole(SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER, LMS_TENANT_ROLES.HEAD_TRAINER, LMS_TENANT_ROLES.TRAINER),
  validate({ params: z.object({ studentId: z.string().uuid() }) }),
  controller.trainerViewProfile);

export default router;
