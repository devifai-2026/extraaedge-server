// Learning module routes. Student sub-router (studentAuthRequired) is registered
// first; everything after self-gates to trainer/head/admin via requireRole.
import express from 'express';
import { z } from 'zod';
import { authRequired, studentAuthRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { SYSTEM_TENANT_ROLES, LMS_TENANT_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';

const router = express.Router();

const idParam = z.object({ id: z.string().uuid() });
const moduleParam = z.object({ moduleId: z.string().uuid() });

const materialBody = z.object({
  program_id: z.string().uuid(),
  module_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  kind: z.enum(['file', 'link']),
  r2_key: z.string().optional(),
  url: z.string().url().optional(),
  file_name: z.string().optional(),
  content_type: z.string().optional(),
  size_bytes: z.coerce.number().int().positive().optional(),
});
const progressBody = z.object({ completed: z.boolean() });
const issueBody = z.object({ program_id: z.string().uuid(), student_id: z.string().uuid() });

// ---------- Student routes ----------
const s = express.Router();
s.use(studentAuthRequired, tenantRequired);
s.get('/student/materials', controller.studentMaterials);
s.get('/student/materials/:id/download', validate({ params: idParam }), controller.studentMaterialUrl);
s.get('/student/progress', controller.studentProgress); // read-only — trainers certify completion
s.get('/student/certificate', controller.studentCertificate);
s.post('/student/certificate/claim', controller.claimCertificate);
s.post('/student/home-extras', controller.studentHomeExtras);
router.use(s);

// ---------- Trainer / head_trainer / admin ----------
router.use(authRequired, tenantRequired, requireRole(
  SYSTEM_TENANT_ROLES.SUPER_ADMIN, SYSTEM_TENANT_ROLES.BRANCH_MANAGER,
  LMS_TENANT_ROLES.HEAD_TRAINER, LMS_TENANT_ROLES.TRAINER,
));

router.get('/materials', controller.listMaterials); // ?programId=
router.post('/materials', validate({ body: materialBody }), controller.createMaterial);
router.delete('/materials/:id', validate({ params: idParam }), controller.deleteMaterial);
router.get('/materials/:id/download', validate({ params: idParam }), controller.trainerMaterialUrl);
router.get('/progress', controller.trainerProgress); // ?programId=
// Trainer certifies module completion per student (+ bulk).
router.get('/module/:moduleId/completion', validate({ params: moduleParam }), controller.moduleCompletion); // ?programId=
router.post('/module-completion', validate({ body: z.object({
  program_id: z.string().uuid(), module_id: z.string().uuid(),
  student_ids: z.array(z.string().uuid()).min(1), completed: z.boolean(),
}) }), controller.markModuleCompletion);
router.get('/certificates', controller.listCertificates); // ?programId=
router.post('/certificates/issue', validate({ body: issueBody }), controller.issueCertificate);

export default router;
