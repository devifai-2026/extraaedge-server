import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { requireRole } from '../../middleware/rbac.js';
import { validate } from '../../middleware/validate.js';
import { ADMIN_TIER_ROLES, MANAGER_TIER_ROLES } from '../../config/constants.js';
import * as controller from './controller.js';
import { createPoolSchema, updatePoolSchema, idParam, knownOrigins } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

// The channels a pool can claim, so the FE picker never drifts from the
// server's LEAD_ORIGINS list.
router.get('/origins', (req, res) => {
  res.json({ data: knownOrigins, meta: { requestId: req.id } });
});

// Managers may READ the routing config (they need to see where their leads
// come from); only admin tier may change it.
router.get('/', requireRole(...MANAGER_TIER_ROLES), controller.list);
router.get('/:id', requireRole(...MANAGER_TIER_ROLES), validate({ params: idParam }), controller.get);

router.post('/', requireRole(...ADMIN_TIER_ROLES), validate({ body: createPoolSchema }), controller.create);
router.put('/:id', requireRole(...ADMIN_TIER_ROLES), validate({ params: idParam, body: updatePoolSchema }), controller.update);
router.delete('/:id', requireRole(...ADMIN_TIER_ROLES), validate({ params: idParam }), controller.remove);

export default router;
