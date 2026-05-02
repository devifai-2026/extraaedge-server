import express from 'express';
import { z } from 'zod';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import { tenantQuery } from '../../db/tenant.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

const query = z.object({ scope: z.enum(['email', 'sms', 'whatsapp']).optional() });

router.get('/', validate({ query }), async (req, res, next) => {
  try {
    const { rows } = req.query.scope
      ? await tenantQuery(req.tenant, `SELECT * FROM template_variables WHERE is_active = true AND $1 = ANY(scope) ORDER BY key`, [req.query.scope])
      : await tenantQuery(req.tenant, `SELECT * FROM template_variables WHERE is_active = true ORDER BY key`);
    res.json({ data: rows, meta: { requestId: req.id } });
  } catch (err) { next(err); }
});

export default router;
