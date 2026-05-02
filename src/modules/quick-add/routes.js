import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { createLead } from '../leads/service.js';
import { leadCreateSchema } from '../leads/schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// Quick add: same as POST /leads but with on_duplicate='warn' by default (so FE can prompt).
router.post('/', validate({ body: leadCreateSchema }), async (req, res, next) => {
  try {
    const lead = await createLead(req.tenant, req.user, req.body, { on_duplicate: 'warn', force: false });
    res.status(201).json({ data: lead, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
