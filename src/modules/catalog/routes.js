import express from 'express';
import { z } from 'zod';
import { studentAuthRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import * as service from './service.js';

const router = express.Router();
router.use(studentAuthRequired, tenantRequired);

router.get('/', async (req, res, next) => {
  try { res.json({ data: await service.catalog(req.tenant, req.student.id), meta: { requestId: req.id } }); } catch (e) { next(e); }
});

router.post('/:programId/enquire', validate({ params: z.object({ programId: z.string().uuid() }) }), async (req, res, next) => {
  try { res.status(201).json({ data: await service.enquire(req.tenant, req.student.id, req.params.programId), meta: { requestId: req.id } }); } catch (e) { next(e); }
});

export default router;
