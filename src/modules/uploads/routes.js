import express from 'express';
import { authRequired } from '../../middleware/auth.js';
import { tenantRequired } from '../../middleware/tenant.js';
import { validate } from '../../middleware/validate.js';
import * as controller from './controller.js';
import { presignSchema, confirmSchema, idParam } from './schema.js';

const router = express.Router();
router.use(authRequired, tenantRequired);

router.post('/presign', validate({ body: presignSchema }), controller.presign);
router.post('/confirm', validate({ body: confirmSchema }), controller.confirm);
router.get('/:id/signed-url', validate({ params: idParam }), controller.signed);
router.delete('/:id', validate({ params: idParam }), controller.remove);

export default router;
